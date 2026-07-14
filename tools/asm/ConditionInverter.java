import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/**
 * Detects and fixes a specific CFR-unfriendly pattern:
 *
 * <pre>
 *   if (cond) goto X;    ← CFR emits ** GOTO
 *   // fallthrough code
 *   ...
 * X:
 *   // target code (typically a loop header or join point)
 * </pre>
 *
 * Transforms into:
 * <pre>
 *   if (!cond) {
 *     // fallthrough code
 *     ...
 *   }
 *   // natural fallthrough to X
 * X:
 *   // target code
 * </pre>
 *
 * This eliminates the problematic forward goto into a structured region by
 * inverting the condition and using structured if/else. CFR handles
 * structured if blocks easily — it's the unstructured goto that causes
 * {@code ** GOTO} markers.
 */
public final class ConditionInverter {
    private ConditionInverter() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: ConditionInverter <input.class> <output.class> [--max-distance N] [--verbose] [--dry-run]");
            System.exit(2);
        }

        Path input = Paths.get(args[0]);
        Path output = Paths.get(args[1]);
        int maxDistance = 200;  // max insns between conditional jump and its target
        boolean verbose = false;
        boolean dryRun = false;

        for (int i = 2; i < args.length; i++) {
            if ("--max-distance".equals(args[i])) {
                maxDistance = Integer.parseInt(args[++i]);
            } else if ("--verbose".equals(args[i])) {
                verbose = true;
            } else if ("--dry-run".equals(args[i])) {
                dryRun = true;
            }
        }

        ClassNode cn = readClass(input);
        int totalFixed = 0;

        for (MethodNode mn : cn.methods) {
            if (mn.instructions == null || mn.instructions.size() == 0) continue;
            int fixed = fixConditionalGotos(mn, maxDistance, verbose);
            totalFixed += fixed;
        }

        System.out.println("ConditionInverter: fixed=" + totalFixed);

        if (!dryRun) {
            ClassWriter cw = new ClassWriter(ClassWriter.COMPUTE_MAXS | ClassWriter.COMPUTE_FRAMES);
            cn.accept(cw);
            Files.createDirectories(output.toAbsolutePath().getParent());
            Files.write(output, cw.toByteArray());
        }
    }

    /**
     * Finds conditional jumps of the form:
     *   if (cond) goto target
     *   [fallthrough block]
     * target:
     *   [target block]
     *
     * Where the fallthrough block has a single entry (from this conditional's
     * false branch) and a single exit (that eventually reaches the target or
     * exits). Transforms to:
     *   if (!cond) { [fallthrough block] }
     *   [target block]
     */
    private static int fixConditionalGotos(MethodNode method, int maxDistance, boolean verbose) {
        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Set<LabelNode> handlers = handlerLabels(method);
        Set<AbstractInsnNode> consumed = new HashSet<>();
        int fixed = 0;

        // We re-scan after each successful fix since modifications invalidate indexes
        boolean changed;
        do {
            changed = false;
            indexes = instructionIndexes(method.instructions);

            for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
                if (consumed.contains(insn)) continue;
                if (!(insn instanceof JumpInsnNode)) continue;

                JumpInsnNode cond = (JumpInsnNode) insn;
                int opcode = cond.getOpcode();
                if (opcode == Opcodes.GOTO || opcode == Opcodes.JSR
                        || inverseConditionalOpcode(opcode) < 0) continue;

                LabelNode target = cond.label;
                if (handlers.contains(target)) continue;

                // Find the fallthrough block
                AbstractInsnNode fallthroughEnd = findLastBeforeTarget(cond, target, indexes);
                if (fallthroughEnd == null) continue;

                Integer condIdx = indexes.get(cond);
                AbstractInsnNode firstAfterCond = firstRealInstruction(cond.getNext());
                Integer fallStartIdx = firstAfterCond != null ? indexes.get(firstAfterCond) : null;
                Integer targetIdx = indexes.get(firstRealInstruction(target));

                if (condIdx == null || fallStartIdx == null || targetIdx == null) continue;
                if (targetIdx - condIdx > maxDistance) continue;

                // Check: fallthrough block must have a single entry (from cond)
                if (!hasSingleEntry(firstAfterCond, cond, method.instructions, indexes)) continue;

                // Check: target must be safe
                if (!isTargetSafe(target, method.instructions, indexes, handlers)) continue;

                // Collect fallthrough instructions
                List<AbstractInsnNode> fallthroughBody = new ArrayList<>();
                AbstractInsnNode cursor = firstAfterCond;
                while (cursor != null && cursor != target && cursor != fallthroughEnd) {
                    if (!(cursor instanceof LabelNode)) {
                        fallthroughBody.add(cursor);
                    }
                    cursor = cursor.getNext();
                }
                if (fallthroughEnd != null && fallthroughEnd != target) {
                    cursor = fallthroughEnd;
                    while (cursor != null && cursor != target) {
                        if (!(cursor instanceof LabelNode)) {
                            fallthroughBody.add(cursor);
                        }
                        cursor = cursor.getNext();
                    }
                }

                if (fallthroughBody.isEmpty()) continue;

                // CRITICAL HEURISTIC: only invert if the fallthrough contains
                // a backedge (a jump to an instruction before the jump).
                // This identifies the fallthrough as a loop body, which is the
                // only case where inverting the outer conditional helps CFR.
                // Inverting non-loop fallthrough just breaks structure.
                if (!containsBackedge(fallthroughBody, indexes)) continue;

                // Build the if-block: invert condition, wrap fallthrough body
                int inverseOpcode = inverseConditionalOpcode(cond.getOpcode());
                if (verbose) {
                    System.out.println("  [fix] " + method.name + method.desc
                            + ": inverting " + opcodeName(cond.getOpcode())
                            + " → " + opcodeName(inverseOpcode));
                }

                // Mark all instructions from cond to target as consumed
                for (AbstractInsnNode n = cond; n != null && n != target; n = n.getNext()) {
                    consumed.add(n);
                }
                consumed.add(target);

                LabelNode ifStart = new LabelNode();
                LabelNode ifEnd = new LabelNode();

                cond.setOpcode(inverseOpcode);
                cond.label = ifEnd;

                method.instructions.insert(cond, ifStart);

                // Insert ifEnd just before the original target label,
                // then insert gotoOut just before ifEnd.
                // Result: ... lastFallthrough -> gotoOut -> ifEnd -> target -> ...
                AbstractInsnNode lastFallthrough = fallthroughBody.get(fallthroughBody.size() - 1);
                JumpInsnNode gotoOut = new JumpInsnNode(Opcodes.GOTO, target);
                method.instructions.insertBefore(target, ifEnd);
                method.instructions.insertBefore(ifEnd, gotoOut);

                fixed++;
                changed = true;
                break; // restart scan after modification
            }
        } while (changed);

        return fixed;
    }

    private static AbstractInsnNode findLastBeforeTarget(
            JumpInsnNode cond, LabelNode target, Map<AbstractInsnNode, Integer> indexes) {
        Integer targetIdx = indexes.get(firstRealInstruction(target));
        if (targetIdx == null) return null;

        AbstractInsnNode cursor = cond;
        AbstractInsnNode lastReal = null;
        while (cursor != null) {
            cursor = cursor.getNext();
            if (cursor == target) break;
            if (cursor instanceof LabelNode) continue;
            if (cursor instanceof FrameNode || cursor instanceof LineNumberNode) continue;
            lastReal = cursor;
            Integer idx = indexes.get(cursor);
            if (idx != null && idx >= targetIdx) return lastReal;
        }
        return lastReal;
    }

    private static boolean hasSingleEntry(
            AbstractInsnNode blockStart, JumpInsnNode cond,
            InsnList instructions, Map<AbstractInsnNode, Integer> indexes) {
        // The block should only be reachable from cond's fallthrough
        // Check: no OTHER jumps (outside the fallthrough region) target
        // any label within this block.
        Set<LabelNode> blockLabels = new HashSet<>();
        AbstractInsnNode cursor = blockStart;
        LabelNode condTarget = cond.label;
        while (cursor != null && cursor != condTarget) {
            if (cursor instanceof LabelNode) {
                blockLabels.add((LabelNode) cursor);
            }
            cursor = cursor.getNext();
        }

        Integer condIdx = indexes.get(cond);
        Integer targetIdx = indexes.get(firstRealInstruction(condTarget));
        if (condIdx == null || targetIdx == null) return false;

        // Only check jumps OUTSIDE the fallthrough region (before cond or after target)
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            Integer idx = indexes.get(insn);
            if (idx == null) continue;
            if (insn instanceof JumpInsnNode) {
                LabelNode jumpTarget = ((JumpInsnNode) insn).label;
                if (jumpTarget != null && blockLabels.contains(jumpTarget)) {
                    // This jump targets our block. Only reject if it's OUTSIDE the fallthrough region.
                    if (idx < condIdx || idx > targetIdx) {
                        return false; // External jump enters this block
                    }
                }
            }
        }
        return true;
    }

    /**
     * Returns true if any jump in the given instruction list targets a label
     * that appears before the jump instruction (a backedge).
     */
    private static boolean containsBackedge(List<AbstractInsnNode> body, Map<AbstractInsnNode, Integer> indexes) {
        for (AbstractInsnNode insn : body) {
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                Integer jumpIdx = indexes.get(jump);
                Integer targetIdx = indexes.get(firstRealInstruction(jump.label));
                if (jumpIdx != null && targetIdx != null && targetIdx < jumpIdx) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isTargetSafe(
            LabelNode target, InsnList instructions,
            Map<AbstractInsnNode, Integer> indexes, Set<LabelNode> handlers) {
        if (handlers.contains(target)) return false;
        // Target must not be at the start of the method (first instruction)
        if (instructions.getFirst() == target) return false;
        return true;
    }

    // -------------------------------------------------------------------------
    // Utility methods
    // -------------------------------------------------------------------------

    private static int inverseConditionalOpcode(int opcode) {
        switch (opcode) {
            case Opcodes.IFEQ: return Opcodes.IFNE;
            case Opcodes.IFNE: return Opcodes.IFEQ;
            case Opcodes.IFLT: return Opcodes.IFGE;
            case Opcodes.IFGE: return Opcodes.IFLT;
            case Opcodes.IFGT: return Opcodes.IFLE;
            case Opcodes.IFLE: return Opcodes.IFGT;
            case Opcodes.IF_ICMPEQ: return Opcodes.IF_ICMPNE;
            case Opcodes.IF_ICMPNE: return Opcodes.IF_ICMPEQ;
            case Opcodes.IF_ICMPLT: return Opcodes.IF_ICMPGE;
            case Opcodes.IF_ICMPGE: return Opcodes.IF_ICMPLT;
            case Opcodes.IF_ICMPGT: return Opcodes.IF_ICMPLE;
            case Opcodes.IF_ICMPLE: return Opcodes.IF_ICMPGT;
            case Opcodes.IF_ACMPEQ: return Opcodes.IF_ACMPNE;
            case Opcodes.IF_ACMPNE: return Opcodes.IF_ACMPEQ;
            case Opcodes.IFNULL: return Opcodes.IFNONNULL;
            case Opcodes.IFNONNULL: return Opcodes.IFNULL;
            default: return -1;
        }
    }

    private static String opcodeName(int opcode) {
        switch (opcode) {
            case Opcodes.IFEQ: return "ifeq";
            case Opcodes.IFNE: return "ifne";
            case Opcodes.IFLT: return "iflt";
            case Opcodes.IFGE: return "ifge";
            case Opcodes.IFGT: return "ifgt";
            case Opcodes.IFLE: return "ifle";
            case Opcodes.IF_ICMPEQ: return "if_icmpeq";
            case Opcodes.IF_ICMPNE: return "if_icmpne";
            case Opcodes.IF_ICMPLT: return "if_icmplt";
            case Opcodes.IF_ICMPGE: return "if_icmpge";
            case Opcodes.IF_ICMPGT: return "if_icmpgt";
            case Opcodes.IF_ICMPLE: return "if_icmple";
            default: return "op:" + opcode;
        }
    }

    private static Set<LabelNode> handlerLabels(MethodNode method) {
        Set<LabelNode> set = new HashSet<>();
        if (method.tryCatchBlocks != null) {
            for (TryCatchBlockNode block : method.tryCatchBlocks) {
                set.add(block.handler);
            }
        }
        return set;
    }

    private static AbstractInsnNode firstRealInstruction(AbstractInsnNode insn) {
        for (AbstractInsnNode cur = insn; cur != null; cur = cur.getNext()) {
            if (cur instanceof LabelNode || cur instanceof FrameNode || cur instanceof LineNumberNode) continue;
            return cur;
        }
        return null;
    }

    private static Map<AbstractInsnNode, Integer> instructionIndexes(InsnList instructions) {
        Map<AbstractInsnNode, Integer> map = new IdentityHashMap<>();
        int i = 0;
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            map.put(insn, i++);
        }
        return map;
    }

    private static ClassNode readClass(Path input) throws IOException {
        ClassReader cr = new ClassReader(Files.readAllBytes(input));
        ClassNode cn = new ClassNode();
        cr.accept(cn, ClassReader.SKIP_DEBUG);
        return cn;
    }
}
