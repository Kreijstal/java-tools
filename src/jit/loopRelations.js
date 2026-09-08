'use strict';

// Induction and local-relation analysis over one method's bytecode.
//
// These questions -- is this local an affine step of that one, does this loop
// carry a counted relation, is this array append packed, does a path exist
// between these blocks -- are asked *about* the code, and answering them writes
// nothing and emits nothing. They were 579 lines in the middle of
// compileMethodBody purely because that is where the CFG and the code items
// were in scope.
//
// The whole set needs exactly five inputs, and every one of them is settled
// before any of these functions is ever called (the CFG and the structured tree
// are both final by the time the renderer reaches its analysis phase), so they
// are captured once by the factory rather than threaded through every call.
// Nothing here touches statement records, emitted names, or any other
// compile-time mutable state.
function createLoopRelations({ cfg, items, labels, structured, directStaticSites }) {
  const localIndex = (instruction, op) => {
        if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
          return Number(instruction.arg);
        }
        const match = /_([0-3])$/.exec(op || "");
        return match ? Number(match[1]) : NaN;
      };

  const opOf = (instruction) => !instruction ? null :
        (typeof instruction === "string" ? instruction : instruction.op);

  const constantInstructionValue = (instruction) => {
        const op = opOf(instruction);
        if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          return op === "iconst_m1" ? -1 : Number(op.slice(-1));
        }
        if (op === "bipush" || op === "sipush" ||
            op === "ldc" || op === "ldc_w") {
          const raw = instruction && typeof instruction === "object"
            ? instruction.arg : undefined;
          const resolved = raw && typeof raw === "object" &&
            Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : raw;
          const number = Number(resolved);
          return Number.isInteger(number) ? number | 0 : null;
        }
        return null;
      };

  const affineLocalStep = (info, slot) => {
        let result = null;
        let writes = 0;
        for (const block of info.loopBlocks) {
          const blockItems = cfg.blocks[block].insns;
          for (let position = 0; position < blockItems.length; position += 1) {
            const itemIndex = blockItems[position];
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op)
              : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
                : null;
            if (writtenSlot !== slot) continue;
            writes += 1;
            if (op === "iinc") {
              const increment = Number(instruction.incr ?? 0);
              if (Number.isInteger(increment)) result = String(increment);
              continue;
            }
            if (position < 3) continue;
            const load = items[blockItems[position - 3]]?.instruction;
            const stepLoad = items[blockItems[position - 2]]?.instruction;
            const add = items[blockItems[position - 1]]?.instruction;
            const loadOp = opOf(load);
            if (!/^iload(?:_[0-3])?$/.test(loadOp) ||
                localIndex(load, loadOp) !== slot ||
                opOf(add) !== "iadd") continue;
            const constantStep = constantInstructionValue(stepLoad);
            if (Number.isInteger(constantStep)) {
              result = String(constantStep);
              continue;
            }
            if (opOf(stepLoad) === "getstatic") {
              const direct = directStaticSites.get(blockItems[position - 2]);
              if (direct?.entryReadCache?.value) {
                result = direct.entryReadCache.value;
              }
            }
          }
        }
        return writes === 1 ? result : null;
      };

  const carriedCountedLocalRelation = (info, candidate) => {
        if (candidate.kind !== "affine-local" || info.initial !== 0 ||
            info.increment <= 0 || candidate.slots.length !== 1) return null;
        const slot = candidate.slots[0];
        if (slot === info.slot || !Number.isInteger(info.boundSlot) ||
            !Number.isInteger(info.preheader)) return null;
        const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
        let initialized = false;
        for (let position = 3; position < preheaderItems.length; position += 1) {
          const load = items[preheaderItems[position - 3]]?.instruction;
          const stride = items[preheaderItems[position - 2]]?.instruction;
          const subtract = items[preheaderItems[position - 1]]?.instruction;
          const store = items[preheaderItems[position]]?.instruction;
          const loadOp = opOf(load), storeOp = opOf(store);
          if (/^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === info.boundSlot &&
              constantInstructionValue(stride) === info.increment &&
              opOf(subtract) === "isub" &&
              /^istore(?:_[0-3])?$/.test(storeOp) &&
              localIndex(store, storeOp) === slot) initialized = true;
        }
        if (!initialized) return null;
        let assignment = null;
        let writes = 0;
        for (const loopBlock of info.loopBlocks) {
          const blockItems = cfg.blocks[loopBlock]?.insns || [];
          for (let position = 1; position < blockItems.length; position += 1) {
            const storeIndex = blockItems[position];
            const store = items[storeIndex]?.instruction;
            const storeOp = opOf(store);
            if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
                localIndex(store, storeOp) !== slot) continue;
            writes += 1;
            const load = items[blockItems[position - 1]]?.instruction;
            const loadOp = opOf(load);
            if (/^iload(?:_[0-3])?$/.test(loadOp) &&
                localIndex(load, loadOp) === info.slot) {
              assignment = {block: loopBlock, itemIndex: storeIndex};
            }
          }
        }
        if (writes !== 1 || !assignment) return null;
        const afterAccess = assignment.block === candidate.block
          ? assignment.itemIndex > candidate.itemIndex
          : loopPathExists(info, candidate.block, assignment.block);
        if (!afterAccess || (info.backedges || []).some((backedge) =>
          assignment.block !== backedge &&
          loopPathExists(info, info.header, backedge, assignment.block))) {
          return null;
        }
        return {slot, offset: candidate.indexAffine?.offset || 0};
      };

  const packedAppendRelation = (info, candidate) => {
        if (candidate.kind !== "affine-local" || info.increment <= 0 ||
            candidate.slots.length !== 1) return null;
        const slot = candidate.slots[0];
        if (slot === info.slot) return null;
        if ([...structured.loopHeaders].some((header) =>
          header !== info.header && info.loopBlocks.has(header))) return null;
        let writeCount = 0;
        const blockWeights = new Map();
        for (const block of info.loopBlocks) {
          let weight = 0;
          for (const itemIndex of cfg.blocks[block]?.insns || []) {
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            const writtenSlot = op === "iinc"
              ? Number(instruction.varnum ?? instruction.arg)
              : /^istore(?:_[0-3])?$/.test(op)
                ? localIndex(instruction, op) : null;
            if (writtenSlot !== slot) continue;
            writeCount += 1;
            if (op !== "iinc" || Number(instruction.incr) !== 1) return null;
            weight += 1;
          }
          blockWeights.set(block, weight);
        }
        if (!writeCount) return null;
        const memo = new Map();
        const visiting = new Set();
        const maximumToBackedge = (block) => {
          if (memo.has(block)) return memo.get(block);
          if (visiting.has(block)) return null;
          visiting.add(block);
          let suffix = -Infinity;
          for (const successor of cfg.succ[block] || []) {
            if (successor === info.header) {
              suffix = Math.max(suffix, 0);
            } else if (info.loopBlocks.has(successor)) {
              const candidateMaximum = maximumToBackedge(successor);
              if (candidateMaximum === null) return null;
              suffix = Math.max(suffix, candidateMaximum);
            }
          }
          visiting.delete(block);
          const maximum = suffix === -Infinity
            ? -Infinity : (blockWeights.get(block) || 0) + suffix;
          memo.set(block, maximum);
          return maximum;
        };
        let incrementsPerTrip = -Infinity;
        for (const successor of cfg.succ[info.header] || []) {
          if (!info.loopBlocks.has(successor) || successor === info.header) continue;
          const maximum = maximumToBackedge(successor);
          if (maximum === null) return null;
          incrementsPerTrip = Math.max(incrementsPerTrip, maximum);
        }
        if (!Number.isInteger(incrementsPerTrip) || incrementsPerTrip <= 0) {
          return null;
        }
        const candidateItems = cfg.blocks[candidate.block]?.insns || [];
        const candidatePosition = candidateItems.indexOf(candidate.itemIndex);
        let postIncrement = false;
        for (let position = candidatePosition - 1; position > 0; position -= 1) {
          const instruction = items[candidateItems[position]]?.instruction;
          const op = opOf(instruction);
          if (op === "iinc" &&
              Number(instruction.varnum ?? instruction.arg) === slot &&
              Number(instruction.incr) === 1) {
            postIncrement = candidateItems.slice(0, position).some((itemIndex) => {
              const load = items[itemIndex]?.instruction;
              const loadOp = opOf(load);
              return /^iload(?:_[0-3])?$/.test(loadOp) &&
                localIndex(load, loadOp) === slot;
            });
            break;
          }
        }
        return {
          slot,
          offset: candidate.indexAffine?.offset || 0,
          incrementsPerTrip,
          postIncrement,
        };
      };

  const binaryLocalAssignment = (info, targetSlot, binaryOp) => {
        let result = null;
        let writes = 0;
        for (const block of info.loopBlocks) {
          const blockItems = cfg.blocks[block].insns;
          for (let position = 0; position < blockItems.length; position += 1) {
            const itemIndex = blockItems[position];
            const instruction = items[itemIndex]?.instruction;
            const op = opOf(instruction);
            const writtenSlot = /^istore(?:_[0-3])?$/.test(op)
              ? localIndex(instruction, op)
              : op === "iinc" ? Number(instruction.varnum ?? instruction.arg)
                : null;
            if (writtenSlot !== targetSlot) continue;
            writes += 1;
            if (position < 3 || op === "iinc") continue;
            const left = items[blockItems[position - 3]]?.instruction;
            const right = items[blockItems[position - 2]]?.instruction;
            const binary = items[blockItems[position - 1]]?.instruction;
            const leftOp = opOf(left);
            const rightOp = opOf(right);
            if (!/^iload(?:_[0-3])?$/.test(leftOp) ||
                !/^iload(?:_[0-3])?$/.test(rightOp) ||
                opOf(binary) !== binaryOp) continue;
            result = {
              left: localIndex(left, leftOp),
              right: localIndex(right, rightOp),
              block,
              itemIndex,
            };
          }
        }
        return writes === 1 ? result : null;
      };

  const cyclicLocalRange = (info, candidate) => {
        if (candidate.kind !== "affine-local" ||
            candidate.slots.length !== 1) return null;
        const indexSlot = candidate.slots[0];
        const candidateIndex = candidate.itemIndex;
        const sampledLoad = items[candidateIndex - 2]?.instruction;
        const sampledIncrement = items[candidateIndex - 1]?.instruction;
        const sampledLoadOp = opOf(sampledLoad);
        if (!/^iload(?:_[0-3])?$/.test(sampledLoadOp) ||
            localIndex(sampledLoad, sampledLoadOp) !== indexSlot ||
            opOf(sampledIncrement) !== "iinc" ||
            Number(sampledIncrement.varnum ?? sampledIncrement.arg) !== indexSlot ||
            Number(sampledIncrement.incr) !== 1) return null;
        const loopItems = [...info.loopBlocks]
          .flatMap((block) => cfg.blocks[block].insns || []);
        const loopItemSet = new Set(loopItems);
        const writtenSlots = new Map();
        for (const itemIndex of loopItems) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const slot = /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op)
            : op === "iinc"
              ? Number(instruction.varnum ?? instruction.arg) : null;
          if (Number.isInteger(slot)) {
            writtenSlots.set(slot, (writtenSlots.get(slot) || 0) + 1);
          }
        }
        for (let position = 0; position + 9 < items.length; position += 1) {
          const sequence = Array.from(
            {length: 10}, (_unused, offset) =>
              items[position + offset]?.instruction);
          if (sequence.some((_instruction, offset) =>
              !loopItemSet.has(position + offset))) continue;
          const phaseIncrement = sequence[0];
          if (opOf(phaseIncrement) !== "iinc" ||
              Number(phaseIncrement.incr) !== 1) continue;
          const phaseSlot =
            Number(phaseIncrement.varnum ?? phaseIncrement.arg);
          const phaseLoadOp = opOf(sequence[1]);
          const modulusLoadOp = opOf(sequence[2]);
          const indexLoadOp = opOf(sequence[4]);
          const secondModulusLoadOp = opOf(sequence[5]);
          const indexStoreOp = opOf(sequence[7]);
          const phaseStoreOp = opOf(sequence[9]);
          if (!/^iload(?:_[0-3])?$/.test(phaseLoadOp) ||
              localIndex(sequence[1], phaseLoadOp) !== phaseSlot ||
              !/^iload(?:_[0-3])?$/.test(modulusLoadOp) ||
              !/^iload(?:_[0-3])?$/.test(indexLoadOp) ||
              localIndex(sequence[4], indexLoadOp) !== indexSlot ||
              !/^iload(?:_[0-3])?$/.test(secondModulusLoadOp) ||
              opOf(sequence[3]) !== "if_icmpne" ||
              opOf(sequence[6]) !== "isub" ||
              !/^istore(?:_[0-3])?$/.test(indexStoreOp) ||
              localIndex(sequence[7], indexStoreOp) !== indexSlot ||
              opOf(sequence[8]) !== "iconst_0" ||
              !/^istore(?:_[0-3])?$/.test(phaseStoreOp) ||
              localIndex(sequence[9], phaseStoreOp) !== phaseSlot) continue;
          const modulusSlot = localIndex(sequence[2], modulusLoadOp);
          if (localIndex(sequence[5], secondModulusLoadOp) !== modulusSlot ||
              info.writtenSlots.has(modulusSlot) ||
              (writtenSlots.get(indexSlot) || 0) !== 2 ||
              (writtenSlots.get(phaseSlot) || 0) !== 2) continue;
          const branchTarget = sequence[3]?.arg;
          const targetIndex = typeof branchTarget === "string"
            ? labels.get(branchTarget.replace(/:$/, "")) : null;
          if (targetIndex !== position + 10) continue;
          return {indexSlot, phaseSlot, modulusSlot};
        }
        return null;
      };

  const nestedCyclicLocalRange = (info, candidate, cyclic, outer) => {
        if (!outer || !outer.loopBlocks.has(info.header)) return null;
        const innerItems = new Set([...info.loopBlocks]
          .flatMap((block) => cfg.blocks[block]?.insns || []));
        const outerOnlyItems = [...outer.loopBlocks]
          .flatMap((block) => cfg.blocks[block]?.insns || [])
          .filter((itemIndex) => !innerItems.has(itemIndex))
          .sort((left, right) => left - right);
        const outerOnlySet = new Set(outerOnlyItems);
        const loadSlot = (instruction) => {
          const op = opOf(instruction);
          return /^iload(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op) : null;
        };
        const storeSlot = (instruction) => {
          const op = opOf(instruction);
          return /^istore(?:_[0-3])?$/.test(op)
            ? localIndex(instruction, op) : null;
        };
        const sequenceAt = (position, length) => {
          const indexes = Array.from(
            {length}, (_unused, offset) => position + offset);
          return indexes.every((itemIndex) => outerOnlySet.has(itemIndex))
            ? indexes.map((itemIndex) => items[itemIndex]?.instruction) : null;
        };

        let rowAdvance = null;
        for (const position of outerOnlyItems) {
          const sequence = sequenceAt(position, 10);
          if (!sequence ||
              loadSlot(sequence[0]) !== cyclic.indexSlot ||
              loadSlot(sequence[1]) !== cyclic.phaseSlot ||
              opOf(sequence[2]) !== "isub" ||
              !Number.isInteger(loadSlot(sequence[3])) ||
              opOf(sequence[4]) !== "iadd" ||
              loadSlot(sequence[5]) !== cyclic.modulusSlot ||
              opOf(sequence[6]) !== "iadd" ||
              storeSlot(sequence[7]) !== cyclic.indexSlot ||
              loadSlot(sequence[8]) !== loadSlot(sequence[3]) ||
              storeSlot(sequence[9]) !== cyclic.phaseSlot) continue;
          if (rowAdvance) return null;
          rowAdvance = {
            position,
            entryPhaseSlot: loadSlot(sequence[3]),
          };
        }
        if (!rowAdvance || outer.writtenSlots.has(rowAdvance.entryPhaseSlot)) {
          return null;
        }

        let verticalWrap = null;
        for (const position of outerOnlyItems) {
          const sequence = sequenceAt(position, 10);
          if (!sequence || opOf(sequence[0]) !== "iinc" ||
              Number(sequence[0].incr) !== 1) continue;
          const rowSlot = Number(sequence[0].varnum ?? sequence[0].arg);
          const heightSlot = loadSlot(sequence[2]);
          const cycleSlot = loadSlot(sequence[7]);
          if (loadSlot(sequence[1]) !== rowSlot ||
              !Number.isInteger(heightSlot) ||
              opOf(sequence[3]) !== "if_icmpne" ||
              opOf(sequence[4]) !== "iconst_0" ||
              storeSlot(sequence[5]) !== rowSlot ||
              loadSlot(sequence[6]) !== cyclic.indexSlot ||
              !Number.isInteger(cycleSlot) ||
              opOf(sequence[8]) !== "isub" ||
              storeSlot(sequence[9]) !== cyclic.indexSlot) continue;
          const branchTarget = sequence[3]?.arg;
          const targetIndex = typeof branchTarget === "string"
            ? labels.get(branchTarget.replace(/:$/, "")) : null;
          if (targetIndex !== position + 10) continue;
          if (verticalWrap) return null;
          verticalWrap = {position, rowSlot, heightSlot, cycleSlot};
        }
        if (!verticalWrap ||
            outer.writtenSlots.has(verticalWrap.heightSlot) ||
            outer.writtenSlots.has(verticalWrap.cycleSlot) ||
            outer.writtenSlots.has(cyclic.modulusSlot)) return null;

        const firstOuterItem = Math.min(...[...outer.loopBlocks]
          .flatMap((block) => cfg.blocks[block]?.insns || []));
        let entryPhaseInitializationCount = 0;
        let cycleInitializationCount = 0;
        for (let position = 1; position < firstOuterItem; position += 1) {
          const store = items[position]?.instruction;
          if (storeSlot(store) === rowAdvance.entryPhaseSlot &&
              loadSlot(items[position - 1]?.instruction) === cyclic.phaseSlot) {
            entryPhaseInitializationCount += 1;
          }
          if (position >= 3 &&
              storeSlot(store) === verticalWrap.cycleSlot &&
              opOf(items[position - 1]?.instruction) === "imul") {
            const left = loadSlot(items[position - 3]?.instruction);
            const right = loadSlot(items[position - 2]?.instruction);
            if ((left === verticalWrap.heightSlot &&
                 right === cyclic.modulusSlot) ||
                (right === verticalWrap.heightSlot &&
                 left === cyclic.modulusSlot)) {
              cycleInitializationCount += 1;
            }
          }
        }
        if (entryPhaseInitializationCount !== 1 ||
            cycleInitializationCount !== 1) return null;

        const writeCounts = new Map();
        for (const itemIndex of [...outer.loopBlocks]
          .flatMap((block) => cfg.blocks[block]?.insns || [])) {
          const instruction = items[itemIndex]?.instruction;
          const op = opOf(instruction);
          const slot = op === "iinc"
            ? Number(instruction.varnum ?? instruction.arg)
            : storeSlot(instruction);
          if (Number.isInteger(slot)) {
            writeCounts.set(slot, (writeCounts.get(slot) || 0) + 1);
          }
        }
        if (writeCounts.get(cyclic.indexSlot) !== 4 ||
            writeCounts.get(cyclic.phaseSlot) !== 3 ||
            writeCounts.get(verticalWrap.rowSlot) !== 2 ||
            writeCounts.has(rowAdvance.entryPhaseSlot) ||
            writeCounts.has(verticalWrap.heightSlot) ||
            writeCounts.has(verticalWrap.cycleSlot) ||
            writeCounts.has(cyclic.modulusSlot)) return null;

        return {
          outer,
          entryPhaseSlot: rowAdvance.entryPhaseSlot,
          rowSlot: verticalWrap.rowSlot,
          heightSlot: verticalWrap.heightSlot,
          cycleSlot: verticalWrap.cycleSlot,
        };
      };

  const loopPathExists = (info, start, target, blocked = null) => {
        if (start === blocked) return false;
        const pending = [start];
        const visited = new Set();
        while (pending.length) {
          const block = pending.pop();
          if (block === blocked || visited.has(block)) continue;
          if (block === target) return true;
          visited.add(block);
          for (const successor of cfg.succ[block] || []) {
            // Crossing the natural-loop backedge starts the next iteration and
            // cannot establish ordering within the current one.
            if (successor === info.header ||
                !info.loopBlocks.has(successor)) continue;
            pending.push(successor);
          }
        }
        return false;
      };

  const loopAssignmentDominates = (info, assignment, candidate) => {
        if (assignment.block === candidate.block) {
          return assignment.itemIndex < candidate.itemIndex;
        }
        if (assignment.block === info.header) return true;
        return !loopPathExists(
          info, info.header, candidate.block, assignment.block);
      };

  const scaledCountedLocalRelation = (info, candidate) => {
        if (candidate.kind !== "scaled-local" || info.increment !== 1 ||
            info.initial !== 0 || candidate.slots.length !== 1) return null;
        const slot = candidate.slots[0];
        if (slot === info.slot) return {kind: "induction"};
        if (!Number.isInteger(info.boundSlot) ||
            !Number.isInteger(info.preheader)) return null;
        const preheaderItems = cfg.blocks[info.preheader]?.insns || [];
        let initialized = false;
        for (let position = 3; position < preheaderItems.length; position += 1) {
          const load = items[preheaderItems[position - 3]]?.instruction;
          const one = items[preheaderItems[position - 2]]?.instruction;
          const subtract = items[preheaderItems[position - 1]]?.instruction;
          const store = items[preheaderItems[position]]?.instruction;
          const loadOp = opOf(load), storeOp = opOf(store);
          if (/^iload(?:_[0-3])?$/.test(loadOp) &&
              localIndex(load, loadOp) === info.boundSlot &&
              constantInstructionValue(one) === 1 &&
              opOf(subtract) === "isub" &&
              /^istore(?:_[0-3])?$/.test(storeOp) &&
              localIndex(store, storeOp) === slot) {
            initialized = true;
          }
        }
        if (!initialized) return null;

        let assignment = null;
        let writes = 0;
        for (const loopBlock of info.loopBlocks) {
          const blockItems = cfg.blocks[loopBlock]?.insns || [];
          for (let position = 1; position < blockItems.length; position += 1) {
            const storeIndex = blockItems[position];
            const store = items[storeIndex]?.instruction;
            const storeOp = opOf(store);
            if (!/^istore(?:_[0-3])?$/.test(storeOp) ||
                localIndex(store, storeOp) !== slot) continue;
            writes += 1;
            const load = items[blockItems[position - 1]]?.instruction;
            const loadOp = opOf(load);
            if (/^iload(?:_[0-3])?$/.test(loadOp) &&
                localIndex(load, loadOp) === info.slot) {
              assignment = {block: loopBlock, itemIndex: storeIndex};
            }
          }
        }
        if (writes !== 1 || !assignment) return null;
        const afterAccess = assignment.block === candidate.block
          ? assignment.itemIndex > candidate.itemIndex
          : loopPathExists(info, candidate.block, assignment.block);
        if (!afterAccess) return null;
        if ((info.backedges || []).some((backedge) =>
            assignment.block !== backedge &&
            loopPathExists(info, info.header, backedge, assignment.block))) {
          return null;
        }
        return {kind: "carried"};
      };

  const quotientProductRecurrence = (info, candidate) => {
        const slots = candidate.slots;
        for (let derivedIndex = 0; derivedIndex < slots.length;
          derivedIndex += 1) {
          const derivedSlot = slots[derivedIndex];
          const offsetSlot = slots[1 - derivedIndex];
          if (info.writtenSlots.has(offsetSlot)) continue;
          const multiply = binaryLocalAssignment(info, derivedSlot, "imul");
          if (!multiply) continue;
          for (const [quotientSlot, multiplierSlot] of [
            [multiply.left, multiply.right],
            [multiply.right, multiply.left],
          ]) {
            if (info.writtenSlots.has(multiplierSlot)) continue;
            const divide =
              binaryLocalAssignment(info, quotientSlot, "idiv");
            if (!divide || info.writtenSlots.has(divide.right)) continue;
            const recurrenceSlot = divide.left;
            const recurrence =
              binaryLocalAssignment(info, recurrenceSlot, "iadd");
            if (!recurrence) continue;
            const stepSlot = recurrence.left === recurrenceSlot
              ? recurrence.right
              : recurrence.right === recurrenceSlot
                ? recurrence.left : null;
            if (!Number.isInteger(stepSlot) ||
                info.writtenSlots.has(stepSlot)) continue;
            if (!loopAssignmentDominates(info, divide, candidate) ||
                !loopAssignmentDominates(info, multiply, candidate)) continue;
            // The recurrence update must occur exactly once on every path to a
            // backedge and after this access in the current iteration. This
            // excludes conditionally updated or update-before-sample loops whose
            // endpoint formula would require a different starting value.
            if ((info.backedges || []).some((backedge) =>
                recurrence.block !== backedge &&
                loopPathExists(
                  info, info.header, backedge, recurrence.block))) continue;
            const updatePrecedesCandidate =
              recurrence.block === candidate.block
                ? recurrence.itemIndex < candidate.itemIndex
                : loopPathExists(
                  info, recurrence.block, candidate.block);
            if (updatePrecedesCandidate) continue;
            return {
              recurrenceSlot,
              stepSlot,
              divisorSlot: divide.right,
              multiplierSlot,
              offsetSlot,
            };
          }
        }
        return null;
      };

  return {
    localIndex,
    opOf,
    constantInstructionValue,
    affineLocalStep,
    carriedCountedLocalRelation,
    packedAppendRelation,
    binaryLocalAssignment,
    cyclicLocalRange,
    nestedCyclicLocalRange,
    loopPathExists,
    loopAssignmentDominates,
    scaledCountedLocalRelation,
    quotientProductRecurrence,
  };
}

module.exports = { createLoopRelations };
