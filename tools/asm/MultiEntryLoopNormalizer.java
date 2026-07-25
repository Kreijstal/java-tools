import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FrameNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.JumpInsnNode;
import org.objectweb.asm.tree.LabelNode;
import org.objectweb.asm.tree.LineNumberNode;
import org.objectweb.asm.tree.LookupSwitchInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TableSwitchInsnNode;
import org.objectweb.asm.tree.TryCatchBlockNode;
import org.objectweb.asm.tree.analysis.Analyzer;
import org.objectweb.asm.tree.analysis.BasicInterpreter;
import org.objectweb.asm.tree.analysis.BasicValue;
import org.objectweb.asm.tree.analysis.Frame;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Generic multi-entry loop header normalizer for obfuscated JVM bytecode.
 *
 * <p>This pass targets a common obfuscation pattern where a loop header block has
 * multiple incoming edges from semantically different sources (e.g., drain code,
 * decode fallthrough, backedges). Decompilers like CFR struggle with these patterns
 * and emit {@code ** GOTO} or bad labels.</p>
 *
 * <p>The normalizer works by:</p>
 * <ol>
 *   <li>Building the control-flow graph and computing dominator trees via ASM analysis.</li>
 *   <li>Identifying "join labels" — labels with multiple incoming jump edges where at
 *       least one edge is a backedge (source dominates target in the reverse graph,
 *       i.e., target's instruction index &lt; source's).</li>
 *   <li>For each join label, checking that the block starting at that label is
 *       cloneable (no switches, no JSR, bounded size, stack-neutral entry).</li>
 *   <li>Cloning the shared block for each non-backedge incoming jump and redirecting
 *       those jumps to the clone, leaving backedges on the original.</li>
 *   <li>This separates the "entry paths" from the "loop body" so decompilers can
 *       structure the code properly.</li>
 * </ol>
 *
 * <p>Additionally handles fallthrough-join normalization: if a label is reached
 * both by jumps and by fallthrough from a preceding block, and the total incoming
 * count exceeds a threshold, the fallthrough path is redirected through a goto
 * to a cloned block.</p>
 *
 * <p>This is a fully generic pass — no hardcoded field names, method names, or
 * instruction patterns. It operates purely on CFG shape.</p>
 */
public final class MultiEntryLoopNormalizer {
    private MultiEntryLoopNormalizer() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: MultiEntryLoopNormalizer <input.class> <output.class> [options]");
            System.err.println("Options:");
            System.err.println("  --min-incoming <N>       Minimum incoming edges to consider a join (default: 2)");
            System.err.println("  --max-clone-insns <N>    Max real instructions in a cloneable block (default: 64)");
            System.err.println("  --max-fallthrough <N>    Max incoming for fallthrough normalization (default: 3)");
            System.err.println("  --normalize-fallthrough  Enable fallthrough join normalization");
            System.err.println("  --dry-run                Report what would be done without writing output");
            System.err.println("  --verbose                Print per-method statistics");
            System.exit(2);
        }

        Path input = Paths.get(args[0]);
        Path output = Paths.get(args[1]);
        int minIncoming = 2;
        int maxCloneInsns = 64;
        int maxFallthrough = 3;
        boolean normalizeFallthrough = false;
        boolean dryRun = false;
        boolean verbose = false;

        for (int i = 2; i < args.length; i++) {
            if ("--min-incoming".equals(args[i])) {
                minIncoming = Integer.parseInt(args[++i]);
            } else if ("--max-clone-insns".equals(args[i])) {
                maxCloneInsns = Integer.parseInt(args[++i]);
            } else if ("--max-fallthrough".equals(args[i])) {
                maxFallthrough = Integer.parseInt(args[++i]);
            } else if ("--normalize-fallthrough".equals(args[i])) {
                normalizeFallthrough = true;
            } else if ("--dry-run".equals(args[i])) {
                dryRun = true;
            } else if ("--verbose".equals(args[i])) {
                verbose = true;
            } else {
                throw new IllegalArgumentException("Unknown argument: " + args[i]);
            }
        }

        ClassNode classNode = readClass(input);
        int totalSplits = 0;
        int totalFallthrough = 0;
        int totalMerged = 0;

        for (MethodNode method : classNode.methods) {
            if (method.instructions == null || method.instructions.size() == 0) {
                continue;
            }

            Frame<BasicValue>[] frames;
            try {
                frames = new Analyzer<>(new BasicInterpreter()).analyze(classNode.name, method);
            } catch (Exception ignored) {
                if (verbose) {
                    System.out.println("  [skip] " + method.name + method.desc + ": analysis failed");
                }
                continue;
            }

            Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
            Map<LabelNode, List<JumpInsnNode>> incomingJumps = incomingJumps(method.instructions);
            Set<LabelNode> handlerLabels = handlerLabels(method);

            // Phase 1: Multi-entry loop header splitting
            int splits = splitMultiEntryHeaders(
                    classNode.name, method, frames, indexes, incomingJumps, handlerLabels,
                    minIncoming, maxCloneInsns, verbose);
            totalSplits += splits;

            // Phase 2: Fallthrough join normalization
            if (normalizeFallthrough) {
                int ft = normalizeFallthroughJoins(
                        classNode.name, method, frames, indexes, incomingJumps,
                        handlerLabels, maxFallthrough, maxCloneInsns, verbose);
                totalFallthrough += ft;
            }

            // Phase 3: Merge duplicate consecutive blocks created by cloning
            int merged = mergeDuplicateBlocks(method, verbose ? classNode.name : null);
            if (merged > 0 && verbose) {
                System.out.println("  [merge] " + classNode.name + "." + method.name + method.desc
                        + ": merged " + merged + " duplicate blocks");
            }
            totalMerged += merged;
        }

        System.out.println("MultiEntryLoopNormalizer: splits=" + totalSplits
                + " fallthrough=" + totalFallthrough
                + " merged=" + totalMerged);

        if (!dryRun) {
            ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
            classNode.accept(writer);
            Files.createDirectories(output.toAbsolutePath().getParent());
            Files.write(output, writer.toByteArray());
        }
    }

    // -------------------------------------------------------------------------
    // Phase 1: Multi-entry loop header splitting
    // -------------------------------------------------------------------------

    private static int splitMultiEntryHeaders(
            String owner,
            MethodNode method,
            Frame<BasicValue>[] frames,
            Map<AbstractInsnNode, Integer> indexes,
            Map<LabelNode, List<JumpInsnNode>> incomingJumps,
            Set<LabelNode> handlerLabels,
            int minIncoming,
            int maxCloneInsns,
            boolean verbose) {

        int splits = 0;
        // We need to iterate carefully since we modify the instruction list.
        // Collect candidates first, then process.
        List<Map.Entry<LabelNode, List<JumpInsnNode>>> candidates = new ArrayList<>();
        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : incomingJumps.entrySet()) {
            LabelNode target = entry.getKey();
            List<JumpInsnNode> jumps = entry.getValue();
            if (jumps.size() < minIncoming) continue;
            if (handlerLabels.contains(target)) continue;
            candidates.add(entry);
        }

        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : candidates) {
            LabelNode target = entry.getKey();
            List<JumpInsnNode> jumps = entry.getValue();

            // Re-check: the label might have been moved by earlier splits in this method
            if (!indexes.containsKey(target)) continue;

            // Classify incoming edges into backedges and forward edges
            List<JumpInsnNode> backedges = new ArrayList<>();
            List<JumpInsnNode> forwardEdges = new ArrayList<>();
            for (JumpInsnNode jump : jumps) {
                Integer jumpIdx = indexes.get(jump);
                Integer targetIdx = indexes.get(target);
                if (jumpIdx != null && targetIdx != null && jumpIdx >= targetIdx) {
                    backedges.add(jump);
                } else {
                    forwardEdges.add(jump);
                }
            }

            // We need at least one backedge and at least one non-backedge
            // for this to be a multi-entry loop header.
            if (backedges.isEmpty() || forwardEdges.isEmpty()) continue;

            // Check stack neutrality at the target
            AbstractInsnNode firstReal = firstRealInstruction(target);
            if (firstReal == null) continue;
            Integer firstIdx = indexes.get(firstReal);
            if (firstIdx == null || firstIdx < 0 || firstIdx >= frames.length) continue;
            Frame<BasicValue> frame = frames[firstIdx];
            if (frame == null || frame.getStackSize() != 0) continue;

            // Find the cloneable block starting at this label
            Block block = findCloneableBlockFrom(method.instructions, target, indexes, maxCloneInsns);
            if (block == null) continue;

            // Clone the block for each forward edge and redirect
            for (JumpInsnNode jump : forwardEdges) {
                InsnList clone = cloneBlock(method, block);
                LabelNode clonedEntry = (LabelNode) clone.getFirst();
                method.instructions.insertBefore(target, clone);
                jump.label = clonedEntry;
                splits++;
            }

            if (verbose && !forwardEdges.isEmpty()) {
                System.out.println("  [split] " + owner + "." + method.name + method.desc
                        + ": " + forwardEdges.size() + " edges redirected, "
                        + backedges.size() + " backedges preserved");
            }
        }

        return splits;
    }

    // -------------------------------------------------------------------------
    // Phase 2: Fallthrough join normalization
    // -------------------------------------------------------------------------

    private static int normalizeFallthroughJoins(
            String owner,
            MethodNode method,
            Frame<BasicValue>[] frames,
            Map<AbstractInsnNode, Integer> indexes,
            Map<LabelNode, List<JumpInsnNode>> incomingJumps,
            Set<LabelNode> handlerLabels,
            int maxFallthrough,
            int maxCloneInsns,
            boolean verbose) {

        int normalized = 0;
        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : incomingJumps.entrySet()) {
            LabelNode target = entry.getKey();
            if (handlerLabels.contains(target)) continue;
            if (!hasFallthroughPredecessor(method.instructions, target)) continue;

            List<JumpInsnNode> jumps = entry.getValue();
            int totalIncoming = jumps.size() + 1;
            if (totalIncoming < maxFallthrough) continue;

            AbstractInsnNode firstReal = firstRealInstruction(target);
            if (firstReal == null) continue;
            Integer firstIdx = indexes.get(firstReal);
            if (firstIdx == null || firstIdx < 0 || firstIdx >= frames.length) continue;
            Frame<BasicValue> frame = frames[firstIdx];
            if (frame == null || frame.getStackSize() != 0) continue;

            Block block = findCloneableBlockFrom(method.instructions, target, indexes, maxCloneInsns);
            if (block == null) continue;

            // Clone the block
            InsnList clone = cloneBlock(method, block);
            LabelNode clonedEntry = (LabelNode) clone.getFirst();

            // Insert goto first, THEN the clone. This ensures the goto comes
            // BEFORE the clone's instructions, not after its return.
            JumpInsnNode fallthroughGoto = new JumpInsnNode(Opcodes.GOTO, clonedEntry);
            method.instructions.insertBefore(target, fallthroughGoto);
            method.instructions.insertBefore(target, clone);

            normalized++;
            if (verbose) {
                System.out.println("  [fallthrough] " + owner + "." + method.name + method.desc
                        + ": normalized fallthrough join with " + totalIncoming + " incoming");
            }
        }
        return normalized;
    }

    // -------------------------------------------------------------------------
    // Block analysis helpers
    // -------------------------------------------------------------------------

    /**
     * Finds a cloneable block starting at the given label.
     * By default, clones only up to the first conditional jump (the "header").
     * With --full-block, clones up to the next LabelNode or until a terminal/switch.
     */
    private static Block findCloneableBlockFrom(
            InsnList instructions,
            LabelNode start,
            Map<AbstractInsnNode, Integer> indexes,
            int maxInsns) {

        return findCloneableBlockFrom(instructions, start, indexes, maxInsns, false);
    }

    private static Block findCloneableBlockFrom(
            InsnList instructions,
            LabelNode start,
            Map<AbstractInsnNode, Integer> indexes,
            int maxInsns,
            boolean fullBlock) {

        List<AbstractInsnNode> body = new ArrayList<>();
        int realCount = 0;
        AbstractInsnNode lastReal = null;

        for (AbstractInsnNode insn = start; insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode && insn != start) break;
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) continue;
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) return null;

            body.add(insn);
            if (!(insn instanceof LabelNode)) {
                realCount++;
                lastReal = insn;
            }
            if (realCount > maxInsns) return null;

            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                if (jump.getOpcode() == Opcodes.JSR) return null;
                if (!fullBlock || jump.getOpcode() == Opcodes.GOTO) {
                    // In header-only mode, stop at first conditional.
                    // In full-block mode, stop only at unconditional gotos.
                    AbstractInsnNode fallthrough = firstRealInstruction(insn.getNext());
                    LabelNode fallthroughLabel = fallthrough != null
                            ? ensureLabelBefore(instructions, fallthrough) : null;
                    return new Block(body, fallthroughLabel);
                }
            }
            if (isTerminal(insn.getOpcode())) {
                return new Block(body, null);
            }
        }
        if (body.isEmpty()) return null;
        // Fell off the block (next label or end of method)
        AbstractInsnNode afterBlock = lastReal != null ? lastReal.getNext() : null;
        LabelNode fallthrough = null;
        if (afterBlock instanceof LabelNode) {
            fallthrough = (LabelNode) afterBlock;
        }
        return new Block(body, fallthrough);
    }

    /**
     * A conditional jump still allows fallthrough, so only unconditional
     * terminators (goto, return, athrow, ret) block fallthrough.
     */
    private static boolean blocksFallthrough(AbstractInsnNode insn) {
        if (insn == null) return true;
        int opcode = insn.getOpcode();
        // Unconditional jumps and terminals block fallthrough
        if (opcode == Opcodes.GOTO || isTerminal(opcode)) return true;
        // Tableswitch/lookupswitch block fallthrough
        if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) return true;
        return false;
    }

    private static boolean hasFallthroughPredecessor(InsnList instructions, LabelNode label) {
        AbstractInsnNode prev = label.getPrevious();
        while (prev != null) {
            if (prev instanceof LabelNode || prev instanceof FrameNode || prev instanceof LineNumberNode) {
                prev = prev.getPrevious();
                continue;
            }
            return !blocksFallthrough(prev);
        }
        return false;
    }

    private static LabelNode findFallthroughPredecessor(InsnList instructions, LabelNode label) {
        // Walk backwards to find the label that starts the fallthrough region.
        // If no label exists, we create one just before the target so we have
        // a place to insert the redirecting goto.
        AbstractInsnNode cursor = label.getPrevious();
        AbstractInsnNode lastRealBeforeGap = null;
        while (cursor != null) {
            if (cursor instanceof LabelNode) return (LabelNode) cursor;
            if (cursor instanceof FrameNode || cursor instanceof LineNumberNode) {
                cursor = cursor.getPrevious();
                continue;
            }
            lastRealBeforeGap = cursor;
            if (blocksFallthrough(cursor)) return null;
            cursor = cursor.getPrevious();
        }
        // No label found — fallthrough comes from entry. Create one.
        if (lastRealBeforeGap != null) {
            LabelNode newLabel = new LabelNode();
            instructions.insertBefore(lastRealBeforeGap, newLabel);
            return newLabel;
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // ASM utility helpers
    // -------------------------------------------------------------------------

    private static Map<AbstractInsnNode, Integer> instructionIndexes(InsnList instructions) {
        Map<AbstractInsnNode, Integer> indexes = new IdentityHashMap<>();
        int index = 0;
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            indexes.put(insn, index++);
        }
        return indexes;
    }

    private static Map<LabelNode, List<JumpInsnNode>> incomingJumps(InsnList instructions) {
        Map<LabelNode, List<JumpInsnNode>> incoming = new IdentityHashMap<>();
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                incoming.computeIfAbsent(jump.label, ignored -> new ArrayList<>()).add(jump);
            } else if (insn instanceof TableSwitchInsnNode) {
                TableSwitchInsnNode sw = (TableSwitchInsnNode) insn;
                incoming.computeIfAbsent(sw.dflt, ignored -> new ArrayList<>());
                for (LabelNode label : sw.labels) {
                    incoming.computeIfAbsent(label, ignored -> new ArrayList<>());
                }
            } else if (insn instanceof LookupSwitchInsnNode) {
                LookupSwitchInsnNode sw = (LookupSwitchInsnNode) insn;
                incoming.computeIfAbsent(sw.dflt, ignored -> new ArrayList<>());
                for (LabelNode label : sw.labels) {
                    incoming.computeIfAbsent(label, ignored -> new ArrayList<>());
                }
            }
        }
        return incoming;
    }

    private static Set<LabelNode> handlerLabels(MethodNode method) {
        Set<LabelNode> labels = new HashSet<>();
        if (method.tryCatchBlocks == null) return labels;
        for (TryCatchBlockNode block : method.tryCatchBlocks) {
            labels.add(block.handler);
        }
        return labels;
    }

    private static AbstractInsnNode firstRealInstruction(AbstractInsnNode insn) {
        for (AbstractInsnNode cur = insn; cur != null; cur = cur.getPrevious()) {
            if (cur instanceof LabelNode || cur instanceof FrameNode || cur instanceof LineNumberNode) {
                continue;
            }
            return cur;
        }
        for (AbstractInsnNode cur = insn; cur != null; cur = cur.getNext()) {
            if (cur instanceof LabelNode || cur instanceof FrameNode || cur instanceof LineNumberNode) {
                continue;
            }
            return cur;
        }
        return null;
    }

    private static LabelNode ensureLabelBefore(InsnList instructions, AbstractInsnNode insn) {
        if (insn instanceof LabelNode) return (LabelNode) insn;
        if (insn.getPrevious() instanceof LabelNode) return (LabelNode) insn.getPrevious();
        LabelNode label = new LabelNode();
        instructions.insertBefore(insn, label);
        return label;
    }

    private static InsnList cloneBlock(MethodNode method, Block block) {
        // Collect all labels that appear in the block (as label definitions)
        Set<LabelNode> blockLabels = new HashSet<>();
        for (AbstractInsnNode insn : block.body) {
            if (insn instanceof LabelNode) {
                blockLabels.add((LabelNode) insn);
            }
        }

        Map<LabelNode, LabelNode> labelMap = new IdentityHashMap<>();
        // Create new labels for labels defined in the block
        for (LabelNode label : blockLabels) {
            labelMap.put(label, new LabelNode());
        }
        // Map all other labels (e.g., fallthrough, external targets) to themselves
        for (AbstractInsnNode insn : block.body) {
            if (insn instanceof JumpInsnNode) {
                LabelNode target = ((JumpInsnNode) insn).label;
                if (!labelMap.containsKey(target)) {
                    labelMap.put(target, target);
                }
            }
        }
        if (block.fallthroughLabel != null && !labelMap.containsKey(block.fallthroughLabel)) {
            labelMap.put(block.fallthroughLabel, block.fallthroughLabel);
        }

        // Clone: labels first, then real instructions
        InsnList clone = new InsnList();
        for (AbstractInsnNode insn : block.body) {
            if (insn instanceof LabelNode) {
                clone.add(labelMap.get((LabelNode) insn));
            }
        }
        for (AbstractInsnNode insn : block.body) {
            if (insn instanceof LabelNode) continue;
            AbstractInsnNode cloned = insn.clone(labelMap);
            clone.add(cloned);
        }
        return clone;
    }

    private static boolean isTerminal(int opcode) {
        return opcode == Opcodes.RETURN
                || opcode == Opcodes.IRETURN
                || opcode == Opcodes.LRETURN
                || opcode == Opcodes.FRETURN
                || opcode == Opcodes.DRETURN
                || opcode == Opcodes.ARETURN
                || opcode == Opcodes.ATHROW
                || opcode == Opcodes.RET;
    }

    private static ClassNode readClass(Path input) throws IOException {
        ClassReader reader = new ClassReader(Files.readAllBytes(input));
        ClassNode classNode = new ClassNode();
        reader.accept(classNode, ClassReader.SKIP_DEBUG);
        return classNode;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Merge duplicate consecutive blocks
    // -------------------------------------------------------------------------

    /**
     * After cloning, we may have consecutive identical blocks that both
     * conditionally jump to the same external targets. CFR sees duplicate
     * conditionals to the same place and marks them as {@code ** GOTO}.
     * This pass detects and merges those duplicates.
     *
     * <p>Important: does NOT merge blocks where either is a backedge target
     * (loop header), because those splits are intentional.</p>
     */
    private static int mergeDuplicateBlocks(MethodNode method, String owner) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Map<LabelNode, List<JumpInsnNode>> incoming = incomingJumps(method.instructions);
        Set<LabelNode> handlerLabels = handlerLabels(method);

        // Collect candidate labels
        List<LabelNode> labels = new ArrayList<>();
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode) {
                labels.add((LabelNode) insn);
            }
        }

        if (labels.size() < 2) return 0;

        // Determine which labels are backedge targets or exception handlers.
        // Never merge those — they're intentional loop headers.
        Set<LabelNode> protectedLabels = new HashSet<>(handlerLabels);
        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : incoming.entrySet()) {
            LabelNode target = entry.getKey();
            Integer targetIdx = indexes.get(firstRealInstruction(target));
            if (targetIdx == null) continue;
            for (JumpInsnNode jump : entry.getValue()) {
                Integer jumpIdx = indexes.get(jump);
                if (jumpIdx != null && targetIdx != null && jumpIdx >= targetIdx) {
                    // This is a backedge → target is a loop header
                    protectedLabels.add(target);
                    break;
                }
            }
        }

        // Also protect labels that are the only entry to a loop
        // (labels with a backedge predecessor and ≤1 forward predecessor)
        int merged = 0;
        Map<LabelNode, LabelNode> replacementMap = new IdentityHashMap<>();
        for (int i = 0; i < labels.size() - 1; i++) {
            LabelNode a = labels.get(i);
            LabelNode b = labels.get(i + 1);
            if (replacementMap.containsKey(a) || replacementMap.containsKey(b)) continue;
            if (protectedLabels.contains(a) || protectedLabels.contains(b)) continue;
            if (!areBlocksIdentical(a, b, indexes)) continue;

            // Only merge if targets are the same
            if (!haveSameJumpTargets(a, b)) continue;

            // Keep the first one, redirect from second
            replacementMap.put(b, a);
            merged++;
        }

        if (replacementMap.isEmpty()) return 0;

        // Redirect all JumpInsnNodes and switch targets from b → a
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                LabelNode replacement = replacementMap.get(jump.label);
                if (replacement != null) {
                    jump.label = replacement;
                }
            } else if (insn instanceof TableSwitchInsnNode) {
                TableSwitchInsnNode sw = (TableSwitchInsnNode) insn;
                LabelNode rep = replacementMap.get(sw.dflt);
                if (rep != null) sw.dflt = rep;
                for (int j = 0; j < sw.labels.size(); j++) {
                    rep = replacementMap.get(sw.labels.get(j));
                    if (rep != null) sw.labels.set(j, rep);
                }
            } else if (insn instanceof LookupSwitchInsnNode) {
                LookupSwitchInsnNode sw = (LookupSwitchInsnNode) insn;
                LabelNode rep = replacementMap.get(sw.dflt);
                if (rep != null) sw.dflt = rep;
                for (int j = 0; j < sw.labels.size(); j++) {
                    rep = replacementMap.get(sw.labels.get(j));
                    if (rep != null) sw.labels.set(j, rep);
                }
            }
        }

        // Update try-catch blocks
        if (method.tryCatchBlocks != null) {
            for (TryCatchBlockNode block : method.tryCatchBlocks) {
                LabelNode rep = replacementMap.get(block.handler);
                if (rep != null) block.handler = rep;
                rep = replacementMap.get(block.start);
                if (rep != null) block.start = rep;
                rep = replacementMap.get(block.end);
                if (rep != null) block.end = rep;
            }
        }

        return merged;
    }

    private static boolean haveSameJumpTargets(LabelNode a, LabelNode b) {
        Set<LabelNode> targetsA = collectJumpTargets(a);
        Set<LabelNode> targetsB = collectJumpTargets(b);
        return targetsA.equals(targetsB);
    }

    private static Set<LabelNode> collectJumpTargets(LabelNode start) {
        Set<LabelNode> targets = new HashSet<>();
        for (AbstractInsnNode insn = start.getNext(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode) break;
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) continue;
            if (insn instanceof JumpInsnNode) {
                targets.add(((JumpInsnNode) insn).label);
                if (insn.getOpcode() == Opcodes.GOTO) break;
            } else if (insn instanceof TableSwitchInsnNode) {
                TableSwitchInsnNode sw = (TableSwitchInsnNode) insn;
                targets.add(sw.dflt);
                targets.addAll(sw.labels);
                break;
            } else if (insn instanceof LookupSwitchInsnNode) {
                LookupSwitchInsnNode sw = (LookupSwitchInsnNode) insn;
                targets.add(sw.dflt);
                targets.addAll(sw.labels);
                break;
            }
            if (isTerminal(insn.getOpcode())) break;
        }
        return targets;
    }

    /**
     * Two blocks are "identical" if they have the same sequence of real
     * instructions (same opcodes, same operands), and their jump/switch
     * targets resolve to the same labels.
     */
    private static boolean areBlocksIdentical(LabelNode a, LabelNode b, Map<AbstractInsnNode, Integer> indexes) {
        List<AbstractInsnNode> bodyA = realInstructionsUntilNextLabelOrGoto(a);
        List<AbstractInsnNode> bodyB = realInstructionsUntilNextLabelOrGoto(b);
        if (bodyA.size() != bodyB.size()) return false;

        for (int i = 0; i < bodyA.size(); i++) {
            AbstractInsnNode ia = bodyA.get(i);
            AbstractInsnNode ib = bodyB.get(i);
            if (ia.getOpcode() != ib.getOpcode()) return false;
            if (ia.getType() != ib.getType()) return false;

            // Compare operands
            if (ia instanceof org.objectweb.asm.tree.VarInsnNode) {
                if (((org.objectweb.asm.tree.VarInsnNode) ia).var != ((org.objectweb.asm.tree.VarInsnNode) ib).var) return false;
            } else if (ia instanceof org.objectweb.asm.tree.IntInsnNode) {
                if (((org.objectweb.asm.tree.IntInsnNode) ia).operand != ((org.objectweb.asm.tree.IntInsnNode) ib).operand) return false;
            } else if (ia instanceof org.objectweb.asm.tree.FieldInsnNode) {
                org.objectweb.asm.tree.FieldInsnNode fa = (org.objectweb.asm.tree.FieldInsnNode) ia;
                org.objectweb.asm.tree.FieldInsnNode fb = (org.objectweb.asm.tree.FieldInsnNode) ib;
                if (!fa.owner.equals(fb.owner) || !fa.name.equals(fb.name) || !fa.desc.equals(fb.desc)) return false;
            } else if (ia instanceof org.objectweb.asm.tree.MethodInsnNode) {
                org.objectweb.asm.tree.MethodInsnNode ma = (org.objectweb.asm.tree.MethodInsnNode) ia;
                org.objectweb.asm.tree.MethodInsnNode mb = (org.objectweb.asm.tree.MethodInsnNode) ib;
                if (!ma.owner.equals(mb.owner) || !ma.name.equals(mb.name) || !ma.desc.equals(mb.desc)) return false;
            } else if (ia instanceof org.objectweb.asm.tree.IincInsnNode) {
                org.objectweb.asm.tree.IincInsnNode iia = (org.objectweb.asm.tree.IincInsnNode) ia;
                org.objectweb.asm.tree.IincInsnNode iib = (org.objectweb.asm.tree.IincInsnNode) ib;
                if (iia.var != iib.var || iia.incr != iib.incr) return false;
            } else if (ia instanceof org.objectweb.asm.tree.LdcInsnNode) {
                if (!((org.objectweb.asm.tree.LdcInsnNode) ia).cst.equals(((org.objectweb.asm.tree.LdcInsnNode) ib).cst)) return false;
            } else if (ia instanceof org.objectweb.asm.tree.TypeInsnNode) {
                if (!((org.objectweb.asm.tree.TypeInsnNode) ia).desc.equals(((org.objectweb.asm.tree.TypeInsnNode) ib).desc)) return false;
            }
            // JumpInsnNode and switch nodes are compared by their targets
        }
        return true;
    }

    private static List<AbstractInsnNode> realInstructionsUntilNextLabelOrGoto(LabelNode start) {
        List<AbstractInsnNode> body = new ArrayList<>();
        for (AbstractInsnNode insn = start.getNext(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode) break;
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) continue;
            body.add(insn);
            if (insn instanceof JumpInsnNode && insn.getOpcode() == Opcodes.GOTO) break;
            if (isTerminal(insn.getOpcode())) break;
        }
        return body;
    }

    // -------------------------------------------------------------------------
    // Inner types
    // -------------------------------------------------------------------------

    private static final class Block {
        final List<AbstractInsnNode> body;
        final LabelNode fallthroughLabel;

        Block(List<AbstractInsnNode> body, LabelNode fallthroughLabel) {
            this.body = body;
            this.fallthroughLabel = fallthroughLabel;
        }
    }
}
