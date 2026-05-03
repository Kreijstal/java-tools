import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.FrameNode;
import org.objectweb.asm.tree.IincInsnNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.IntInsnNode;
import org.objectweb.asm.tree.JumpInsnNode;
import org.objectweb.asm.tree.LabelNode;
import org.objectweb.asm.tree.LineNumberNode;
import org.objectweb.asm.tree.VarInsnNode;
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
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class JoinBlockSplitter {
    private JoinBlockSplitter() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: JoinBlockSplitter <input.class> <output.class> [--min-incoming N] [--max-insns N] [--leave-one-original] [--cleanup-jumps] [--split-diamonds] [--split-latches] [--merge-duplicate-blocks] [--merge-dispatches] [--merge-preheaders] [--split-init-preheaders] [--orient-null-dispatches] [--fold-entry-stores] [--fold-single-assignment-locals] [--verbose]");
            System.err.println("       [--assume-static owner.name:desc=value]");
            System.exit(2);
        }

        Path input = Paths.get(args[0]);
        Path output = Paths.get(args[1]);
        int minIncoming = 3;
        int maxInsns = 8;
        boolean leaveOneOriginal = false;
        boolean cleanupJumps = false;
        boolean splitDiamonds = false;
        boolean splitLatches = false;
        boolean mergeDuplicateBlocks = false;
        boolean mergeDispatches = false;
        boolean mergePreheaders = false;
        boolean splitInitPreheaders = false;
        boolean orientNullDispatches = false;
        boolean foldEntryStores = false;
        boolean foldSingleAssignmentLocals = false;
        boolean verbose = false;
        List<StaticAssumption> staticAssumptions = new ArrayList<>();

        for (int i = 2; i < args.length; i++) {
            if ("--min-incoming".equals(args[i])) {
                minIncoming = Integer.parseInt(args[++i]);
            } else if ("--max-insns".equals(args[i])) {
                maxInsns = Integer.parseInt(args[++i]);
            } else if ("--leave-one-original".equals(args[i])) {
                leaveOneOriginal = true;
            } else if ("--cleanup-jumps".equals(args[i])) {
                cleanupJumps = true;
            } else if ("--split-diamonds".equals(args[i])) {
                splitDiamonds = true;
            } else if ("--split-latches".equals(args[i])) {
                splitLatches = true;
            } else if ("--merge-duplicate-blocks".equals(args[i])) {
                mergeDuplicateBlocks = true;
            } else if ("--merge-dispatches".equals(args[i])) {
                mergeDispatches = true;
            } else if ("--merge-preheaders".equals(args[i])) {
                mergePreheaders = true;
            } else if ("--split-init-preheaders".equals(args[i])) {
                splitInitPreheaders = true;
            } else if ("--orient-null-dispatches".equals(args[i])) {
                orientNullDispatches = true;
            } else if ("--fold-entry-stores".equals(args[i])) {
                foldEntryStores = true;
            } else if ("--fold-single-assignment-locals".equals(args[i])) {
                foldSingleAssignmentLocals = true;
            } else if ("--verbose".equals(args[i])) {
                verbose = true;
            } else if ("--assume-static".equals(args[i])) {
                staticAssumptions.add(StaticAssumption.parse(args[++i]));
            } else {
                throw new IllegalArgumentException("Unknown argument: " + args[i]);
            }
        }

        ClassNode classNode = readClass(input);
        int staticFolds = 0;
        int deadRemoved = 0;
        int splitCount = 0;
        int cleanupCount = 0;
        int diamondCount = 0;
        int latchCount = 0;
        int mergedBlocks = 0;
        int mergedDispatches = 0;
        int mergedPreheaders = 0;
        int splitInitHeaders = 0;
        int orientedDispatches = 0;
        for (MethodNode method : classNode.methods) {
            int methodFolds = 0;
            methodFolds += foldStaticAssumptions(method, staticAssumptions);
            if (foldEntryStores) {
                methodFolds += propagateEntryConstantStores(method);
            }
            if (foldSingleAssignmentLocals) {
                methodFolds += propagateSingleAssignmentIntLocals(method);
            }
            for (int i = 0; i < 4; i++) {
                int roundChanges = 0;
                if (foldSingleAssignmentLocals) {
                    roundChanges += propagateSingleAssignmentIntLocals(method);
                }
                roundChanges += foldConstantBranches(method);
                methodFolds += roundChanges;
                if (roundChanges == 0) {
                    break;
                }
            }
            staticFolds += methodFolds;
            if (methodFolds > 0) {
                deadRemoved += removeUnreachableCode(method);
            }
            if (mergeDuplicateBlocks) {
                mergedBlocks += mergeDuplicateGotoBlocks(method, 32);
                deadRemoved += removeUnreachableCode(method);
            }
            if (cleanupJumps && !mergeDispatches) {
                cleanupCount += cleanupJumps(method);
            }
            if (mergeDispatches) {
                mergedDispatches += mergeEquivalentDispatches(method);
                deadRemoved += removeUnreachableCode(method);
                cleanupCount += cleanupJumps(method);
            }
            if (mergePreheaders) {
                mergedPreheaders += mergeEquivalentPreheaders(method);
                deadRemoved += removeUnreachableCode(method);
                cleanupCount += cleanupJumps(method);
            }
            if (splitInitPreheaders) {
                splitInitHeaders += splitInitialPreheaders(method);
                deadRemoved += removeUnreachableCode(method);
                cleanupCount += cleanupJumps(method);
            }
            if (orientNullDispatches) {
                orientedDispatches += orientNullDispatches(method);
                deadRemoved += removeUnreachableCode(method);
                cleanupCount += cleanupJumps(method);
            }
            if (cleanupJumps || splitDiamonds) {
                cleanupCount += cleanupJumps(method);
            }
            int methodSplits = splitMethod(classNode.name, method, minIncoming, maxInsns, leaveOneOriginal);
            if (cleanupJumps || splitDiamonds) {
                cleanupCount += cleanupJumps(method);
            }
            if (splitDiamonds) {
                diamondCount += splitForwardDiamonds(method, 180);
                cleanupCount += cleanupJumps(method);
            }
            if (splitLatches) {
                latchCount += splitSharedGotoLatches(method, 64);
                cleanupCount += cleanupJumps(method);
            }
            if (cleanupJumps) {
                deadRemoved += removeUnreachableCode(method);
            }
            splitCount += methodSplits;
            if (verbose && methodSplits > 0) {
                System.out.println(method.name + method.desc + ": " + methodSplits);
            }
        }

        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        classNode.accept(writer);
        Files.createDirectories(output.toAbsolutePath().getParent());
        Files.write(output, writer.toByteArray());
        if (!staticAssumptions.isEmpty() || foldEntryStores || foldSingleAssignmentLocals) {
            System.out.println("static folds: " + staticFolds);
            System.out.println("dead instructions removed: " + deadRemoved);
        }
        System.out.println("split joins: " + splitCount);
        if (splitDiamonds) {
            System.out.println("split diamonds: " + diamondCount);
        }
        if (splitLatches) {
            System.out.println("split latches: " + latchCount);
        }
        if (mergeDuplicateBlocks) {
            System.out.println("merged duplicate blocks: " + mergedBlocks);
        }
        if (mergeDispatches) {
            System.out.println("merged dispatches: " + mergedDispatches);
        }
        if (mergePreheaders) {
            System.out.println("merged preheaders: " + mergedPreheaders);
        }
        if (splitInitPreheaders) {
            System.out.println("split init preheaders: " + splitInitHeaders);
        }
        if (orientNullDispatches) {
            System.out.println("oriented null dispatches: " + orientedDispatches);
        }
        if (cleanupJumps || splitDiamonds || splitLatches) {
            System.out.println("jump cleanups: " + cleanupCount);
        }
    }

    private static int foldStaticAssumptions(MethodNode method, List<StaticAssumption> assumptions) {
        if (assumptions.isEmpty() || method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; ) {
            AbstractInsnNode next = insn.getNext();
            if (!(insn instanceof FieldInsnNode) || insn.getOpcode() != Opcodes.GETSTATIC) {
                insn = next;
                continue;
            }
            FieldInsnNode field = (FieldInsnNode) insn;
            for (StaticAssumption assumption : assumptions) {
                if (assumption.matches(field)) {
                    method.instructions.set(insn, pushInt(assumption.intValue));
                    changes += 1;
                    break;
                }
            }
            insn = next;
        }
        return changes;
    }

    private static int propagateSingleAssignmentIntLocals(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<Integer, Integer> assignedConstants = new HashMap<>();
        Map<Integer, Integer> assignmentCounts = new HashMap<>();
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            Integer storeLocal = intStoreLocal(insn);
            if (storeLocal != null) {
                assignmentCounts.put(storeLocal, assignmentCounts.getOrDefault(storeLocal, 0) + 1);
                Integer constant = pushedInt(previousRealInstruction(insn));
                if (constant != null) {
                    assignedConstants.put(storeLocal, constant);
                } else {
                    assignedConstants.remove(storeLocal);
                }
                continue;
            }
            if (insn.getOpcode() == Opcodes.IINC) {
                int local = ((IincInsnNode) insn).var;
                assignmentCounts.put(local, assignmentCounts.getOrDefault(local, 0) + 1);
                assignedConstants.remove(local);
            }
        }

        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; ) {
            AbstractInsnNode next = insn.getNext();
            Integer loadLocal = intLoadLocal(insn);
            if (loadLocal == null) {
                insn = next;
                continue;
            }
            Integer constant = assignedConstants.get(loadLocal);
            if (constant == null || assignmentCounts.getOrDefault(loadLocal, 0) != 1) {
                insn = next;
                continue;
            }
            method.instructions.set(insn, pushInt(constant));
            changes += 1;
            insn = next;
        }
        return changes;
    }

    private static int propagateEntryConstantStores(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<Integer, Integer> entryConstants = new HashMap<>();
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode || insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            Integer storeLocal = intStoreLocal(insn);
            if (storeLocal != null) {
                Integer constant = pushedInt(previousRealInstruction(insn));
                if (constant != null) {
                    entryConstants.put(storeLocal, constant);
                    continue;
                }
            }
            if (!entryConstants.isEmpty() && isHarmlessEntryInstruction(insn)) {
                continue;
            }
            break;
        }
        if (entryConstants.isEmpty()) {
            return 0;
        }

        int changes = 0;
        for (Map.Entry<Integer, Integer> entry : entryConstants.entrySet()) {
            int local = entry.getKey();
            int value = entry.getValue();
            boolean skipFirstStore = true;
            for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; ) {
                AbstractInsnNode next = insn.getNext();
                Integer storeLocal = intStoreLocal(insn);
                if (storeLocal != null && storeLocal == local) {
                    if (skipFirstStore) {
                        skipFirstStore = false;
                        insn = next;
                        continue;
                    }
                    break;
                }
                if (insn.getOpcode() == Opcodes.IINC && ((IincInsnNode) insn).var == local) {
                    break;
                }
                Integer loadLocal = intLoadLocal(insn);
                if (loadLocal != null && loadLocal == local) {
                    method.instructions.set(insn, pushInt(value));
                    changes += 1;
                }
                insn = next;
            }
        }
        return changes;
    }

    private static boolean isHarmlessEntryInstruction(AbstractInsnNode insn) {
        int opcode = insn.getOpcode();
        return pushedInt(insn) != null
                || intStoreLocal(insn) != null
                || (opcode >= Opcodes.ILOAD && opcode <= Opcodes.ALOAD)
                || (opcode >= 26 && opcode <= 45);
    }

    private static int foldConstantBranches(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; ) {
            AbstractInsnNode next = insn.getNext();
            if (!(insn instanceof JumpInsnNode)) {
                insn = next;
                continue;
            }
            JumpInsnNode jump = (JumpInsnNode) insn;
            AbstractInsnNode previous = previousRealInstruction(insn);
            Integer value = pushedInt(previous);
            if (value == null) {
                insn = next;
                continue;
            }
            Boolean branchTaken = evaluateSingleIntBranch(jump.getOpcode(), value);
            if (branchTaken == null) {
                insn = next;
                continue;
            }
            if (previous != null) {
                method.instructions.remove(previous);
            }
            if (branchTaken) {
                method.instructions.set(insn, new JumpInsnNode(Opcodes.GOTO, jump.label));
                changes += 1;
            } else {
                method.instructions.remove(insn);
                changes += 1;
            }
            insn = next;
        }
        return changes;
    }

    private static int removeUnreachableCode(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Set<AbstractInsnNode> reachable = reachableInstructions(method, indexes);
        int removed = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode || insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (reachable.contains(insn)) {
                continue;
            }
            AbstractInsnNode remove = insn;
            insn = insn.getPrevious();
            method.instructions.remove(remove);
            removed += 1;
            if (insn == null) {
                break;
            }
        }

        if (method.tryCatchBlocks != null && !method.tryCatchBlocks.isEmpty()) {
            List<TryCatchBlockNode> kept = new ArrayList<>();
            for (TryCatchBlockNode block : method.tryCatchBlocks) {
                if (hasReachableProtectedInstruction(block, method.instructions, reachable)
                        && firstRealInstruction(block.handler) != null) {
                    kept.add(block);
                }
            }
            method.tryCatchBlocks = kept;
        }

        return removed;
    }

    private static Set<AbstractInsnNode> reachableInstructions(MethodNode method, Map<AbstractInsnNode, Integer> indexes) {
        Set<AbstractInsnNode> reachable = new HashSet<>();
        ArrayDeque<AbstractInsnNode> work = new ArrayDeque<>();
        AbstractInsnNode first = firstRealInstruction(method.instructions.getFirst());
        if (first != null) {
            work.add(first);
        }

        boolean changed;
        do {
            changed = false;
            while (!work.isEmpty()) {
                AbstractInsnNode insn = firstRealInstruction(work.removeFirst());
                if (insn == null || reachable.contains(insn)) {
                    continue;
                }
                reachable.add(insn);
                changed = true;
                enqueueSuccessors(insn, work);
            }

            if (method.tryCatchBlocks != null) {
                for (TryCatchBlockNode block : method.tryCatchBlocks) {
                    if (!reachable.contains(firstRealInstruction(block.handler))
                            && hasReachableProtectedInstruction(block, method.instructions, reachable)) {
                        AbstractInsnNode handler = firstRealInstruction(block.handler);
                        if (handler != null) {
                            work.add(handler);
                        }
                    }
                }
            }
        } while (changed || !work.isEmpty());

        return reachable;
    }

    private static void enqueueSuccessors(AbstractInsnNode insn, ArrayDeque<AbstractInsnNode> work) {
        if (insn instanceof JumpInsnNode) {
            JumpInsnNode jump = (JumpInsnNode) insn;
            work.add(jump.label);
            if (jump.getOpcode() != Opcodes.GOTO && jump.getOpcode() != Opcodes.JSR) {
                AbstractInsnNode next = firstRealInstruction(insn.getNext());
                if (next != null) {
                    work.add(next);
                }
            }
            return;
        }
        if (insn instanceof TableSwitchInsnNode) {
            TableSwitchInsnNode sw = (TableSwitchInsnNode) insn;
            work.add(sw.dflt);
            for (LabelNode label : sw.labels) {
                work.add(label);
            }
            return;
        }
        if (insn instanceof LookupSwitchInsnNode) {
            LookupSwitchInsnNode sw = (LookupSwitchInsnNode) insn;
            work.add(sw.dflt);
            for (LabelNode label : sw.labels) {
                work.add(label);
            }
            return;
        }
        if (isTerminal(insn.getOpcode())) {
            return;
        }
        AbstractInsnNode next = firstRealInstruction(insn.getNext());
        if (next != null) {
            work.add(next);
        }
    }

    private static boolean hasReachableProtectedInstruction(
            TryCatchBlockNode block,
            InsnList instructions,
            Set<AbstractInsnNode> reachable
    ) {
        boolean inRange = false;
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn == block.start) {
                inRange = true;
            }
            if (insn == block.end) {
                return false;
            }
            if (inRange && !(insn instanceof LabelNode) && reachable.contains(insn)) {
                return true;
            }
        }
        return false;
    }

    private static Boolean evaluateSingleIntBranch(int opcode, int value) {
        switch (opcode) {
            case Opcodes.IFEQ:
                return value == 0;
            case Opcodes.IFNE:
                return value != 0;
            case Opcodes.IFLT:
                return value < 0;
            case Opcodes.IFGE:
                return value >= 0;
            case Opcodes.IFGT:
                return value > 0;
            case Opcodes.IFLE:
                return value <= 0;
            default:
                return null;
        }
    }

    private static AbstractInsnNode previousRealInstruction(AbstractInsnNode insn) {
        for (AbstractInsnNode previous = insn == null ? null : insn.getPrevious();
             previous != null;
             previous = previous.getPrevious()) {
            if (previous instanceof LabelNode || previous instanceof FrameNode || previous instanceof LineNumberNode) {
                continue;
            }
            return previous;
        }
        return null;
    }

    private static Integer intStoreLocal(AbstractInsnNode insn) {
        int opcode = insn.getOpcode();
        if (insn instanceof VarInsnNode && opcode == Opcodes.ISTORE) {
            return ((VarInsnNode) insn).var;
        }
        switch (opcode) {
            case 59: // istore_0
                return 0;
            case 60: // istore_1
                return 1;
            case 61: // istore_2
                return 2;
            case 62: // istore_3
                return 3;
            default:
                return null;
        }
    }

    private static Integer intLoadLocal(AbstractInsnNode insn) {
        int opcode = insn.getOpcode();
        if (insn instanceof VarInsnNode && opcode == Opcodes.ILOAD) {
            return ((VarInsnNode) insn).var;
        }
        switch (opcode) {
            case 26: // iload_0
                return 0;
            case 27: // iload_1
                return 1;
            case 28: // iload_2
                return 2;
            case 29: // iload_3
                return 3;
            default:
                return null;
        }
    }

    private static Integer objectStoreLocal(AbstractInsnNode insn) {
        if (insn instanceof VarInsnNode && insn.getOpcode() == Opcodes.ASTORE) {
            return ((VarInsnNode) insn).var;
        }
        switch (insn.getOpcode()) {
            case 75: // astore_0
                return 0;
            case 76: // astore_1
                return 1;
            case 77: // astore_2
                return 2;
            case 78: // astore_3
                return 3;
            default:
                return null;
        }
    }

    private static boolean isAload(AbstractInsnNode insn, int local) {
        int opcode = insn.getOpcode();
        if (insn instanceof VarInsnNode && opcode == Opcodes.ALOAD) {
            return ((VarInsnNode) insn).var == local;
        }
        return opcode == 42 + local && local >= 0 && local <= 3;
    }

    private static boolean isIload(AbstractInsnNode insn, int local) {
        Integer loaded = intLoadLocal(insn);
        return loaded != null && loaded == local;
    }

    private static boolean isField(AbstractInsnNode insn, int opcode, String name, String desc) {
        if (!(insn instanceof FieldInsnNode) || insn.getOpcode() != opcode) {
            return false;
        }
        FieldInsnNode field = (FieldInsnNode) insn;
        return name.equals(field.name) && desc.equals(field.desc);
    }

    private static int instructionIndex(Map<AbstractInsnNode, Integer> indexes, LabelNode label) {
        return indexes.getOrDefault(firstRealInstruction(label), -1);
    }

    private static List<AbstractInsnNode> realInstructionsUntilNextLabel(LabelNode start) {
        List<AbstractInsnNode> body = new ArrayList<>();
        for (AbstractInsnNode insn = start.getNext(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode) {
                break;
            }
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            body.add(insn);
        }
        return body;
    }

    private static Integer pushedInt(AbstractInsnNode insn) {
        if (insn == null) {
            return null;
        }
        switch (insn.getOpcode()) {
            case Opcodes.ICONST_M1:
                return -1;
            case Opcodes.ICONST_0:
                return 0;
            case Opcodes.ICONST_1:
                return 1;
            case Opcodes.ICONST_2:
                return 2;
            case Opcodes.ICONST_3:
                return 3;
            case Opcodes.ICONST_4:
                return 4;
            case Opcodes.ICONST_5:
                return 5;
            case Opcodes.BIPUSH:
            case Opcodes.SIPUSH:
                return ((IntInsnNode) insn).operand;
            default:
                return null;
        }
    }

    private static AbstractInsnNode pushInt(int value) {
        switch (value) {
            case -1:
                return new InsnNode(Opcodes.ICONST_M1);
            case 0:
                return new InsnNode(Opcodes.ICONST_0);
            case 1:
                return new InsnNode(Opcodes.ICONST_1);
            case 2:
                return new InsnNode(Opcodes.ICONST_2);
            case 3:
                return new InsnNode(Opcodes.ICONST_3);
            case 4:
                return new InsnNode(Opcodes.ICONST_4);
            case 5:
                return new InsnNode(Opcodes.ICONST_5);
            default:
                if (value >= Byte.MIN_VALUE && value <= Byte.MAX_VALUE) {
                    return new IntInsnNode(Opcodes.BIPUSH, value);
                }
                if (value >= Short.MIN_VALUE && value <= Short.MAX_VALUE) {
                    return new IntInsnNode(Opcodes.SIPUSH, value);
                }
                throw new IllegalArgumentException("Only small int assumptions are supported: " + value);
        }
    }

    private static ClassNode readClass(Path input) throws IOException {
        ClassReader reader = new ClassReader(Files.readAllBytes(input));
        ClassNode classNode = new ClassNode();
        reader.accept(classNode, ClassReader.SKIP_DEBUG);
        return classNode;
    }

    private static int splitMethod(String owner, MethodNode method, int minIncoming, int maxInsns, boolean leaveOneOriginal) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Frame<BasicValue>[] frames;
        try {
            frames = new Analyzer<>(new BasicInterpreter()).analyze(owner, method);
        } catch (Exception ignored) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Map<LabelNode, List<JumpInsnNode>> incoming = incomingJumps(method.instructions);
        List<LabelNode> handlerLabels = handlerLabels(method);

        int splits = 0;
        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : incoming.entrySet()) {
            LabelNode target = entry.getKey();
            List<JumpInsnNode> jumps = entry.getValue();
            if (jumps.size() < minIncoming || handlerLabels.contains(target)) {
                continue;
            }

            Block block = findCloneableBlock(method.instructions, target, indexes, frames, maxInsns);
            if (block == null) {
                continue;
            }

            int firstJump = leaveOneOriginal ? 1 : 0;
            for (int i = firstJump; i < jumps.size(); i++) {
                JumpInsnNode jump = jumps.get(i);
                InsnList clone = cloneBlock(method, block);
                LabelNode clonedEntry = (LabelNode) clone.getFirst();
                method.instructions.insertBefore(target, clone);
                jump.label = clonedEntry;
                splits += 1;
            }
        }

        return splits;
    }

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

    private static int cleanupJumps(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        int changes = 0;
        boolean changed;
        do {
            changed = false;
            for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
                if (!(insn instanceof JumpInsnNode)) {
                    continue;
                }
                JumpInsnNode jump = (JumpInsnNode) insn;
                LabelNode target = resolveGotoChain(jump.label);
                if (target != jump.label) {
                    jump.label = target;
                    changes += 1;
                    changed = true;
                }
                if (jump.getOpcode() == Opcodes.GOTO && firstRealInstruction(insn.getNext()) == firstRealInstruction(jump.label)) {
                    AbstractInsnNode remove = insn;
                    insn = insn.getPrevious();
                    method.instructions.remove(remove);
                    changes += 1;
                    changed = true;
                    if (insn == null) {
                        break;
                    }
                }
                if (jump.getOpcode() != Opcodes.GOTO && jump.getOpcode() != Opcodes.JSR) {
                    AbstractInsnNode next = firstRealInstruction(jump.getNext());
                    if (next instanceof JumpInsnNode && next.getOpcode() == Opcodes.GOTO) {
                        JumpInsnNode nextGoto = (JumpInsnNode) next;
                        if (firstRealInstruction(next.getNext()) == firstRealInstruction(jump.label)) {
                            int inverse = inverseConditionalOpcode(jump.getOpcode());
                            if (inverse >= 0) {
                                method.instructions.set(jump, new JumpInsnNode(inverse, nextGoto.label));
                                method.instructions.remove(nextGoto);
                                changes += 1;
                                changed = true;
                            }
                        }
                    }
                }
            }
        } while (changed);

        return changes;
    }

    private static int splitForwardDiamonds(MethodNode method, int maxInsns) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        int splits = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (!(insn instanceof JumpInsnNode)) {
                continue;
            }
            JumpInsnNode conditional = (JumpInsnNode) insn;
            int inverseOpcode = inverseConditionalOpcode(conditional.getOpcode());
            if (inverseOpcode < 0) {
                continue;
            }

            AbstractInsnNode next = firstRealInstruction(conditional.getNext());
            if (!(next instanceof JumpInsnNode) || next.getOpcode() != Opcodes.GOTO) {
                continue;
            }
            JumpInsnNode gotoBody = (JumpInsnNode) next;
            LabelNode sideEntry = conditional.label;
            LabelNode bodyEntry = gotoBody.label;
            Integer sideIndex = indexes.get(sideEntry);
            Integer bodyIndex = indexes.get(bodyEntry);
            Integer condIndex = indexes.get(conditional);
            if (sideIndex == null || bodyIndex == null || condIndex == null) {
                continue;
            }
            if (sideIndex <= condIndex || sideIndex >= bodyIndex) {
                continue;
            }

            Block sideBlock = cloneableRange(method.instructions, sideEntry, bodyEntry, maxInsns);
            if (sideBlock == null) {
                continue;
            }

            JumpInsnNode replacement = new JumpInsnNode(inverseOpcode, bodyEntry);
            method.instructions.set(conditional, replacement);
            method.instructions.remove(gotoBody);
            method.instructions.insert(replacement, cloneBlock(method, sideBlock));
            insn = replacement;
            splits += 1;
        }
        return splits;
    }

    private static int splitSharedGotoLatches(MethodNode method, int maxInsns) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<LabelNode, List<JumpInsnNode>> incoming = incomingJumps(method.instructions);
        int splits = 0;
        for (Map.Entry<LabelNode, List<JumpInsnNode>> entry : incoming.entrySet()) {
            LabelNode target = entry.getKey();
            List<JumpInsnNode> gotos = new ArrayList<>();
            for (JumpInsnNode jump : entry.getValue()) {
                if (jump.getOpcode() == Opcodes.GOTO) {
                    gotos.add(jump);
                }
            }
            if (gotos.size() < 2) {
                continue;
            }

            Block latch = findGotoTerminatedBlock(target, maxInsns);
            if (latch == null) {
                continue;
            }

            for (JumpInsnNode jump : gotos) {
                InsnList clone = cloneBlock(method, latch);
                LabelNode clonedEntry = (LabelNode) clone.getFirst();
                method.instructions.insertBefore(target, clone);
                jump.label = clonedEntry;
                splits += 1;
            }
        }
        return splits;
    }

    private static int mergeDuplicateGotoBlocks(MethodNode method, int maxInsns) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Map<String, LabelNode> canonicalBySignature = new HashMap<>();
        Map<LabelNode, LabelNode> replacements = new IdentityHashMap<>();

        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (!(insn instanceof LabelNode)) {
                continue;
            }
            LabelNode label = (LabelNode) insn;
            String signature = gotoBlockSignature(label, indexes, maxInsns);
            if (signature == null) {
                continue;
            }
            LabelNode canonical = canonicalBySignature.get(signature);
            if (canonical == null) {
                canonicalBySignature.put(signature, label);
            } else {
                replacements.put(label, canonical);
            }
        }

        if (replacements.isEmpty()) {
            return 0;
        }

        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                LabelNode replacement = replacements.get(jump.label);
                if (replacement != null) {
                    jump.label = replacement;
                    changes += 1;
                }
            } else if (insn instanceof TableSwitchInsnNode) {
                TableSwitchInsnNode sw = (TableSwitchInsnNode) insn;
                LabelNode replacement = replacements.get(sw.dflt);
                if (replacement != null) {
                    sw.dflt = replacement;
                    changes += 1;
                }
                for (int i = 0; i < sw.labels.size(); i++) {
                    replacement = replacements.get(sw.labels.get(i));
                    if (replacement != null) {
                        sw.labels.set(i, replacement);
                        changes += 1;
                    }
                }
            } else if (insn instanceof LookupSwitchInsnNode) {
                LookupSwitchInsnNode sw = (LookupSwitchInsnNode) insn;
                LabelNode replacement = replacements.get(sw.dflt);
                if (replacement != null) {
                    sw.dflt = replacement;
                    changes += 1;
                }
                for (int i = 0; i < sw.labels.size(); i++) {
                    replacement = replacements.get(sw.labels.get(i));
                    if (replacement != null) {
                        sw.labels.set(i, replacement);
                        changes += 1;
                    }
                }
            }
        }
        return changes;
    }

    private static int mergeEquivalentDispatches(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Map<String, Dispatch> canonical = new HashMap<>();
        List<Dispatch> dispatches = new ArrayList<>();
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            Dispatch dispatch = readDispatch(method, insn, indexes);
            if (dispatch == null) {
                continue;
            }
            dispatches.add(dispatch);
            canonical.put(dispatch.key, dispatch);
        }

        int changes = 0;
        for (Dispatch dispatch : dispatches) {
            Dispatch target = canonical.get(dispatch.key);
            if (target == null || target.loadInsn == dispatch.loadInsn) {
                continue;
            }
            method.instructions.set(dispatch.loadInsn, new JumpInsnNode(Opcodes.GOTO, target.entryLabel));
            method.instructions.remove(dispatch.branchInsn);
            if (dispatch.gotoInsn != null) {
                method.instructions.remove(dispatch.gotoInsn);
            }
            changes += 1;
        }
        return changes;
    }

    private static int mergeEquivalentPreheaders(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        Map<String, LabelNode> canonical = new HashMap<>();
        List<Preheader> preheaders = new ArrayList<>();
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (!(insn instanceof LabelNode)) {
                continue;
            }
            Preheader preheader = readPreheader((LabelNode) insn, indexes);
            if (preheader == null) {
                continue;
            }
            preheaders.add(preheader);
            canonical.putIfAbsent(preheader.key, preheader.entryLabel);
        }

        int changes = 0;
        for (Preheader preheader : preheaders) {
            LabelNode target = canonical.get(preheader.key);
            if (target == null || target == preheader.entryLabel) {
                continue;
            }
            replaceRangeWithGoto(method.instructions, preheader.entryLabel, preheader.endExclusive, target);
            changes += 1;
        }
        return changes;
    }

    private static int orientNullDispatches(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (!(insn instanceof JumpInsnNode) || insn.getOpcode() != Opcodes.IFNULL) {
                continue;
            }
            JumpInsnNode nullJump = (JumpInsnNode) insn;
            AbstractInsnNode next = firstRealInstruction(insn.getNext());
            if (!(next instanceof JumpInsnNode) || next.getOpcode() != Opcodes.GOTO) {
                continue;
            }
            JumpInsnNode gotoNonNull = (JumpInsnNode) next;
            AbstractInsnNode afterGoto = firstRealInstruction(gotoNonNull.getNext());
            if (afterGoto != firstRealInstruction(nullJump.label)) {
                continue;
            }
            method.instructions.set(nullJump, new JumpInsnNode(Opcodes.IFNONNULL, gotoNonNull.label));
            method.instructions.remove(gotoNonNull);
            changes += 1;
        }
        return changes;
    }

    private static int splitInitialPreheaders(MethodNode method) {
        if (method.instructions == null || method.instructions.size() == 0) {
            return 0;
        }

        Map<AbstractInsnNode, Integer> indexes = instructionIndexes(method.instructions);
        int changes = 0;
        for (AbstractInsnNode insn = method.instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (pushedInt(insn) == null) {
                continue;
            }
            LabelNode initLabel = ensureLabelBefore(method.instructions, insn);
            Preheader init = readPreheader(initLabel, indexes);
            if (init == null) {
                continue;
            }
            LabelNode loopHeader = findFollowingLoopPreheader(method.instructions, init, indexes);
            if (loopHeader == null) {
                continue;
            }
            AbstractInsnNode first = firstRealInstruction(init.entryLabel);
            AbstractInsnNode store = firstRealInstruction(first == null ? null : first.getNext());
            if (first == null || store == null || intStoreLocal(store) == null) {
                continue;
            }
            AbstractInsnNode bodyStart = firstRealInstruction(store.getNext());
            if (bodyStart == null) {
                continue;
            }
            method.instructions.insertBefore(bodyStart, new JumpInsnNode(Opcodes.GOTO, loopHeader));
            for (AbstractInsnNode remove = bodyStart;
                 remove != null && remove != init.endExclusive; ) {
                AbstractInsnNode next = remove.getNext();
                if (!(remove instanceof LabelNode)) {
                    method.instructions.remove(remove);
                }
                remove = next;
            }
            changes += 1;
        }
        return changes;
    }

    private static LabelNode findFollowingLoopPreheader(
            InsnList instructions,
            Preheader init,
            Map<AbstractInsnNode, Integer> indexes
    ) {
        AbstractInsnNode cursor = firstRealInstruction(init.endExclusive);
        while (cursor != null) {
            LabelNode label = cursor instanceof LabelNode
                    ? (LabelNode) cursor
                    : ensureLabelBefore(instructions, cursor);
            LoopPreheader loop = readLoopPreheader(label, indexes);
            if (loop != null && loop.key.equals(init.loopKey)) {
                return label;
            }
            AbstractInsnNode real = firstRealInstruction(label);
            if (!(real instanceof JumpInsnNode) || real.getOpcode() != Opcodes.GOTO) {
                AbstractInsnNode next = firstRealInstruction(real == null ? null : real.getNext());
                if (next != null && indexes.getOrDefault(next, -1) < indexes.getOrDefault(firstRealInstruction(init.endExclusive), -1) + 80) {
                    cursor = next;
                    continue;
                }
                return null;
            }
            cursor = firstRealInstruction(real.getNext());
        }
        return null;
    }

    private static Preheader readPreheader(LabelNode entry, Map<AbstractInsnNode, Integer> indexes) {
        List<AbstractInsnNode> body = realInstructionsUntilNextLabel(entry);
        if (body.size() < 16) {
            return null;
        }

        int i = 0;
        Integer zero = pushedInt(body.get(i++));
        if (zero == null || zero != 0) {
            return null;
        }
        Integer indexLocal = intStoreLocal(body.get(i++));
        if (indexLocal == null) {
            return null;
        }
        if (!isAload(body.get(i++), 0)) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "g", "Leb;")) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "b", "I")) {
            return null;
        }
        if (!isIload(body.get(i++), indexLocal)) {
            return null;
        }
        if (!(body.get(i) instanceof JumpInsnNode) || body.get(i).getOpcode() != Opcodes.IF_ICMPLE) {
            return null;
        }
        JumpInsnNode exitJump = (JumpInsnNode) body.get(i++);
        if (!isAload(body.get(i++), 0)) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "g", "Leb;")) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "p", "[Llk;")) {
            return null;
        }
        if (!isIload(body.get(i++), indexLocal)) {
            return null;
        }
        if (body.get(i++).getOpcode() != Opcodes.AALOAD) {
            return null;
        }
        Integer actorLocal = objectStoreLocal(body.get(i++));
        if (actorLocal == null) {
            return null;
        }
        if (!isAload(body.get(i++), actorLocal)) {
            return null;
        }
        if (!(body.get(i) instanceof JumpInsnNode) || body.get(i).getOpcode() != Opcodes.IFNULL) {
            return null;
        }
        JumpInsnNode nullJump = (JumpInsnNode) body.get(i++);
        if (!(body.get(i) instanceof JumpInsnNode) || body.get(i).getOpcode() != Opcodes.GOTO) {
            return null;
        }
        JumpInsnNode nonNullJump = (JumpInsnNode) body.get(i++);

        AbstractInsnNode endExclusive = body.get(i - 1).getNext();
        String key = indexLocal + ":" + actorLocal
                + ":" + instructionIndex(indexes, exitJump.label)
                + ":" + instructionIndex(indexes, nullJump.label)
                + ":" + instructionIndex(indexes, nonNullJump.label);
        String loopKey = indexLocal + ":" + actorLocal + ":" + instructionIndex(indexes, exitJump.label);
        return new Preheader(entry, endExclusive, key, loopKey);
    }

    private static LoopPreheader readLoopPreheader(LabelNode entry, Map<AbstractInsnNode, Integer> indexes) {
        List<AbstractInsnNode> body = realInstructionsUntilNextLabel(entry);
        if (body.size() < 14) {
            return null;
        }

        int i = 0;
        if (!isAload(body.get(i++), 0)) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "g", "Leb;")) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "b", "I")) {
            return null;
        }
        Integer indexLocal = intLoadLocal(body.get(i++));
        if (indexLocal == null) {
            return null;
        }
        if (!(body.get(i) instanceof JumpInsnNode) || body.get(i).getOpcode() != Opcodes.IF_ICMPLE) {
            return null;
        }
        JumpInsnNode exitJump = (JumpInsnNode) body.get(i++);
        if (!isAload(body.get(i++), 0)) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "g", "Leb;")) {
            return null;
        }
        if (!isField(body.get(i++), Opcodes.GETFIELD, "p", "[Llk;")) {
            return null;
        }
        if (!isIload(body.get(i++), indexLocal)) {
            return null;
        }
        if (body.get(i++).getOpcode() != Opcodes.AALOAD) {
            return null;
        }
        Integer actorLocal = objectStoreLocal(body.get(i++));
        if (actorLocal == null) {
            return null;
        }
        if (!isAload(body.get(i++), actorLocal)) {
            return null;
        }
        if (!(body.get(i) instanceof JumpInsnNode)) {
            return null;
        }
        int opcode = body.get(i).getOpcode();
        if (opcode != Opcodes.IFNULL && opcode != Opcodes.IFNONNULL) {
            return null;
        }
        String key = indexLocal + ":" + actorLocal + ":" + instructionIndex(indexes, exitJump.label);
        return new LoopPreheader(key);
    }

    private static void replaceRangeWithGoto(
            InsnList instructions,
            LabelNode start,
            AbstractInsnNode endExclusive,
            LabelNode target
    ) {
        AbstractInsnNode first = firstRealInstruction(start);
        if (first == null) {
            return;
        }
        instructions.insertBefore(first, new JumpInsnNode(Opcodes.GOTO, target));
        for (AbstractInsnNode insn = first; insn != null && insn != endExclusive; ) {
            AbstractInsnNode next = insn.getNext();
            if (!(insn instanceof LabelNode)) {
                instructions.remove(insn);
            }
            insn = next;
        }
    }

    private static Dispatch readDispatch(MethodNode method, AbstractInsnNode insn, Map<AbstractInsnNode, Integer> indexes) {
        if (!(insn instanceof VarInsnNode) || insn.getOpcode() != Opcodes.ALOAD) {
            return null;
        }
        AbstractInsnNode branchInsn = firstRealInstruction(insn.getNext());
        if (!(branchInsn instanceof JumpInsnNode)) {
            return null;
        }
        JumpInsnNode branch = (JumpInsnNode) branchInsn;
        if (branch.getOpcode() != Opcodes.IFNULL && branch.getOpcode() != Opcodes.IFNONNULL) {
            return null;
        }

        LabelNode nullTarget;
        LabelNode nonNullTarget;
        JumpInsnNode gotoInsn = null;
        AbstractInsnNode afterBranch = firstRealInstruction(branch.getNext());
        if (afterBranch instanceof JumpInsnNode && afterBranch.getOpcode() == Opcodes.GOTO) {
            gotoInsn = (JumpInsnNode) afterBranch;
            if (branch.getOpcode() == Opcodes.IFNULL) {
                nullTarget = branch.label;
                nonNullTarget = gotoInsn.label;
            } else {
                nullTarget = gotoInsn.label;
                nonNullTarget = branch.label;
            }
        } else {
            return null;
        }

        Integer nullIndex = indexes.get(firstRealInstruction(nullTarget));
        Integer nonNullIndex = indexes.get(firstRealInstruction(nonNullTarget));
        if (nullIndex == null || nonNullIndex == null) {
            return null;
        }
        LabelNode entry = ensureLabelBefore(method.instructions, insn);
        int local = ((VarInsnNode) insn).var;
        String key = local + ":" + nullIndex + ":" + nonNullIndex;
        return new Dispatch(key, entry, insn, branch, gotoInsn);
    }

    private static String gotoBlockSignature(
            LabelNode start,
            Map<AbstractInsnNode, Integer> indexes,
            int maxInsns
    ) {
        StringBuilder signature = new StringBuilder();
        int realCount = 0;
        for (AbstractInsnNode insn = start; insn != null; insn = insn.getNext()) {
            if (insn instanceof FrameNode || insn instanceof LineNumberNode || insn instanceof LabelNode) {
                continue;
            }
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) {
                return null;
            }
            realCount += 1;
            if (realCount > maxInsns) {
                return null;
            }
            appendInstructionSignature(signature, insn, indexes);
            if (insn instanceof JumpInsnNode && insn.getOpcode() == Opcodes.GOTO) {
                return realCount >= 2 ? signature.toString() : null;
            }
            if (isTerminal(insn.getOpcode())) {
                return null;
            }
        }
        return null;
    }

    private static void appendInstructionSignature(
            StringBuilder signature,
            AbstractInsnNode insn,
            Map<AbstractInsnNode, Integer> indexes
    ) {
        signature.append(insn.getOpcode()).append(':');
        if (insn instanceof VarInsnNode) {
            signature.append(((VarInsnNode) insn).var);
        } else if (insn instanceof IntInsnNode) {
            signature.append(((IntInsnNode) insn).operand);
        } else if (insn instanceof IincInsnNode) {
            IincInsnNode iinc = (IincInsnNode) insn;
            signature.append(iinc.var).append(',').append(iinc.incr);
        } else if (insn instanceof FieldInsnNode) {
            FieldInsnNode field = (FieldInsnNode) insn;
            signature.append(field.owner).append('.').append(field.name).append(':').append(field.desc);
        } else if (insn instanceof org.objectweb.asm.tree.MethodInsnNode) {
            org.objectweb.asm.tree.MethodInsnNode method = (org.objectweb.asm.tree.MethodInsnNode) insn;
            signature.append(method.owner).append('.').append(method.name).append(method.desc);
        } else if (insn instanceof JumpInsnNode) {
            AbstractInsnNode target = firstRealInstruction(((JumpInsnNode) insn).label);
            signature.append(indexes.getOrDefault(target, -1));
        }
        signature.append(';');
    }

    private static Block findGotoTerminatedBlock(LabelNode target, int maxInsns) {
        List<AbstractInsnNode> body = new ArrayList<>();
        int realCount = 0;
        int conditionalCount = 0;
        for (AbstractInsnNode insn = target; insn != null; insn = insn.getNext()) {
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) {
                return null;
            }
            body.add(insn);
            if (!(insn instanceof LabelNode)) {
                realCount += 1;
            }
            if (realCount > maxInsns) {
                return null;
            }
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                if (jump.getOpcode() == Opcodes.GOTO) {
                    return conditionalCount > 0 ? new Block(body, null) : null;
                }
                conditionalCount += 1;
                continue;
            }
            if (isTerminal(insn.getOpcode())) {
                return null;
            }
        }
        return null;
    }

    private static Block cloneableRange(InsnList instructions, LabelNode start, LabelNode end, int maxInsns) {
        List<AbstractInsnNode> body = new ArrayList<>();
        int realCount = 0;
        for (AbstractInsnNode insn = start; insn != null && insn != end; insn = insn.getNext()) {
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) {
                return null;
            }
            body.add(insn);
            if (!(insn instanceof LabelNode)) {
                realCount += 1;
            }
            if (realCount > maxInsns) {
                return null;
            }
            if (isTerminal(insn.getOpcode())) {
                return null;
            }
        }
        if (body.isEmpty()) {
            return null;
        }
        return new Block(body, end);
    }

    private static int inverseConditionalOpcode(int opcode) {
        switch (opcode) {
            case Opcodes.IFEQ:
                return Opcodes.IFNE;
            case Opcodes.IFNE:
                return Opcodes.IFEQ;
            case Opcodes.IFLT:
                return Opcodes.IFGE;
            case Opcodes.IFGE:
                return Opcodes.IFLT;
            case Opcodes.IFGT:
                return Opcodes.IFLE;
            case Opcodes.IFLE:
                return Opcodes.IFGT;
            case Opcodes.IF_ICMPEQ:
                return Opcodes.IF_ICMPNE;
            case Opcodes.IF_ICMPNE:
                return Opcodes.IF_ICMPEQ;
            case Opcodes.IF_ICMPLT:
                return Opcodes.IF_ICMPGE;
            case Opcodes.IF_ICMPGE:
                return Opcodes.IF_ICMPLT;
            case Opcodes.IF_ICMPGT:
                return Opcodes.IF_ICMPLE;
            case Opcodes.IF_ICMPLE:
                return Opcodes.IF_ICMPGT;
            case Opcodes.IF_ACMPEQ:
                return Opcodes.IF_ACMPNE;
            case Opcodes.IF_ACMPNE:
                return Opcodes.IF_ACMPEQ;
            case Opcodes.IFNULL:
                return Opcodes.IFNONNULL;
            case Opcodes.IFNONNULL:
                return Opcodes.IFNULL;
            default:
                return -1;
        }
    }

    private static LabelNode resolveGotoChain(LabelNode label) {
        LabelNode current = label;
        List<LabelNode> seen = new ArrayList<>();
        while (current != null && !seen.contains(current)) {
            seen.add(current);
            AbstractInsnNode first = firstRealInstruction(current);
            if (!(first instanceof JumpInsnNode) || first.getOpcode() != Opcodes.GOTO) {
                return current;
            }
            current = ((JumpInsnNode) first).label;
        }
        return label;
    }

    private static List<LabelNode> handlerLabels(MethodNode method) {
        List<LabelNode> labels = new ArrayList<>();
        if (method.tryCatchBlocks == null) {
            return labels;
        }
        for (TryCatchBlockNode block : method.tryCatchBlocks) {
            labels.add(block.handler);
        }
        return labels;
    }

    private static Block findCloneableBlock(
            InsnList instructions,
            LabelNode target,
            Map<AbstractInsnNode, Integer> indexes,
            Frame<BasicValue>[] frames,
            int maxInsns
    ) {
        Block guardBlock = findCloneableGuardBlock(instructions, target, indexes, frames, maxInsns);
        if (guardBlock != null) {
            return guardBlock;
        }
        return findCloneableConditionalBlock(instructions, target, indexes, frames, maxInsns);
    }

    private static Block findCloneableConditionalBlock(
            InsnList instructions,
            LabelNode target,
            Map<AbstractInsnNode, Integer> indexes,
            Frame<BasicValue>[] frames,
            int maxInsns
    ) {
        AbstractInsnNode first = firstRealInstruction(target);
        if (first == null) {
            return null;
        }

        Integer firstIndex = indexes.get(first);
        if (firstIndex == null || firstIndex < 0 || firstIndex >= frames.length) {
            return null;
        }
        Frame<BasicValue> frame = frames[firstIndex];
        if (frame == null || frame.getStackSize() != 0) {
            return null;
        }

        List<AbstractInsnNode> body = new ArrayList<>();
        int realCount = 0;
        for (AbstractInsnNode insn = first; insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode && insn != target) {
                break;
            }
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) {
                return null;
            }
            body.add(insn);
            if (!(insn instanceof LabelNode)) {
                realCount += 1;
            }
            if (realCount > maxInsns) {
                return null;
            }
            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                if (jump.getOpcode() == Opcodes.GOTO || jump.getOpcode() == Opcodes.JSR) {
                    return null;
                }
                AbstractInsnNode fallthrough = firstRealInstruction(insn.getNext());
                if (fallthrough == null) {
                    return null;
                }
                LabelNode fallthroughLabel = ensureLabelBefore(instructions, fallthrough);
                return new Block(body, fallthroughLabel);
            }
            if (isTerminal(insn.getOpcode())) {
                return null;
            }
        }
        return null;
    }

    private static Block findCloneableGuardBlock(
            InsnList instructions,
            LabelNode target,
            Map<AbstractInsnNode, Integer> indexes,
            Frame<BasicValue>[] frames,
            int maxInsns
    ) {
        AbstractInsnNode first = firstRealInstruction(target);
        if (first == null) {
            return null;
        }

        Integer firstIndex = indexes.get(first);
        if (firstIndex == null || firstIndex < 0 || firstIndex >= frames.length) {
            return null;
        }
        Frame<BasicValue> frame = frames[firstIndex];
        if (frame == null || frame.getStackSize() != 0) {
            return null;
        }

        List<AbstractInsnNode> body = new ArrayList<>();
        int realCount = 0;
        int conditionalCount = 0;
        for (AbstractInsnNode insn = target; insn != null; insn = insn.getNext()) {
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (insn instanceof TableSwitchInsnNode || insn instanceof LookupSwitchInsnNode) {
                return null;
            }

            body.add(insn);
            if (!(insn instanceof LabelNode)) {
                realCount += 1;
            }
            if (realCount > maxInsns) {
                return null;
            }

            if (insn instanceof JumpInsnNode) {
                JumpInsnNode jump = (JumpInsnNode) insn;
                if (jump.getOpcode() == Opcodes.JSR) {
                    return null;
                }
                if (jump.getOpcode() == Opcodes.GOTO) {
                    AbstractInsnNode fallthrough = firstRealInstruction(insn.getNext());
                    if (fallthrough != null && firstRealInstruction(jump.label) == fallthrough) {
                        continue;
                    }
                    return conditionalCount > 0 ? new Block(body, null) : null;
                }
                conditionalCount += 1;
                continue;
            }

            if (isTerminal(insn.getOpcode())) {
                return null;
            }
        }
        return null;
    }

    private static InsnList cloneBlock(MethodNode method, Block block) {
        Map<LabelNode, LabelNode> labels = cloneLabels(method.instructions, block.instructions);
        InsnList clone = new InsnList();
        boolean hasEntry = false;
        for (AbstractInsnNode insn : block.instructions) {
            if (insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            if (insn instanceof LabelNode) {
                clone.add(labels.get((LabelNode) insn));
                hasEntry = true;
                continue;
            }
            if (!hasEntry) {
                clone.add(new LabelNode());
                hasEntry = true;
            }
            clone.add(insn.clone(labels));
        }
        if (!hasEntry) {
            clone.add(new LabelNode());
        }
        if (block.fallthroughLabel != null) {
            clone.add(new JumpInsnNode(Opcodes.GOTO, block.fallthroughLabel));
        }
        return clone;
    }

    private static Map<LabelNode, LabelNode> cloneLabels(InsnList instructions, List<AbstractInsnNode> blockInstructions) {
        Map<LabelNode, LabelNode> labels = new HashMap<>();
        for (AbstractInsnNode insn = instructions.getFirst(); insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode) {
                LabelNode label = (LabelNode) insn;
                labels.put(label, label);
            }
        }
        for (AbstractInsnNode insn : blockInstructions) {
            if (insn instanceof LabelNode) {
                LabelNode label = (LabelNode) insn;
                labels.put(label, new LabelNode());
            }
        }
        return labels;
    }

    private static AbstractInsnNode firstRealInstruction(AbstractInsnNode start) {
        for (AbstractInsnNode insn = start; insn != null; insn = insn.getNext()) {
            if (insn instanceof LabelNode || insn instanceof FrameNode || insn instanceof LineNumberNode) {
                continue;
            }
            return insn;
        }
        return null;
    }

    private static LabelNode ensureLabelBefore(InsnList instructions, AbstractInsnNode insn) {
        AbstractInsnNode previous = insn.getPrevious();
        if (previous instanceof LabelNode) {
            return (LabelNode) previous;
        }
        LabelNode label = new LabelNode();
        instructions.insertBefore(insn, label);
        return label;
    }

    private static boolean isTerminal(int opcode) {
        return opcode == Opcodes.ATHROW
                || opcode == Opcodes.RET
                || (opcode >= Opcodes.IRETURN && opcode <= Opcodes.RETURN);
    }

    private static final class Block {
        private final List<AbstractInsnNode> instructions;
        private final LabelNode fallthroughLabel;

        private Block(List<AbstractInsnNode> instructions, LabelNode fallthroughLabel) {
            this.instructions = instructions;
            this.fallthroughLabel = fallthroughLabel;
        }
    }

    private static final class Dispatch {
        private final String key;
        private final LabelNode entryLabel;
        private final AbstractInsnNode loadInsn;
        private final JumpInsnNode branchInsn;
        private final JumpInsnNode gotoInsn;

        private Dispatch(
                String key,
                LabelNode entryLabel,
                AbstractInsnNode loadInsn,
                JumpInsnNode branchInsn,
                JumpInsnNode gotoInsn
        ) {
            this.key = key;
            this.entryLabel = entryLabel;
            this.loadInsn = loadInsn;
            this.branchInsn = branchInsn;
            this.gotoInsn = gotoInsn;
        }
    }

    private static final class Preheader {
        private final LabelNode entryLabel;
        private final AbstractInsnNode endExclusive;
        private final String key;
        private final String loopKey;

        private Preheader(LabelNode entryLabel, AbstractInsnNode endExclusive, String key, String loopKey) {
            this.entryLabel = entryLabel;
            this.endExclusive = endExclusive;
            this.key = key;
            this.loopKey = loopKey;
        }
    }

    private static final class LoopPreheader {
        private final String key;

        private LoopPreheader(String key) {
            this.key = key;
        }
    }

    private static final class StaticAssumption {
        private final String owner;
        private final String name;
        private final String desc;
        private final int intValue;

        private StaticAssumption(String owner, String name, String desc, int intValue) {
            this.owner = owner;
            this.name = name;
            this.desc = desc;
            this.intValue = intValue;
        }

        private boolean matches(FieldInsnNode field) {
            return owner.equals(field.owner) && name.equals(field.name) && desc.equals(field.desc);
        }

        private static StaticAssumption parse(String value) {
            int equals = value.indexOf('=');
            int colon = value.lastIndexOf(':', equals >= 0 ? equals : value.length());
            int dot = value.lastIndexOf('.', colon);
            if (equals < 0 || colon < 0 || dot < 0) {
                throw new IllegalArgumentException(
                        "--assume-static must look like owner.name:desc=value, e.g. client.A:Z=false"
                );
            }
            String owner = value.substring(0, dot).replace('.', '/');
            String name = value.substring(dot + 1, colon);
            String desc = value.substring(colon + 1, equals);
            String raw = value.substring(equals + 1);
            int intValue;
            if ("Z".equals(desc)) {
                if ("true".equals(raw) || "1".equals(raw)) {
                    intValue = 1;
                } else if ("false".equals(raw) || "0".equals(raw)) {
                    intValue = 0;
                } else {
                    throw new IllegalArgumentException("Boolean assumptions must be true/false/1/0: " + value);
                }
            } else if ("I".equals(desc) || "B".equals(desc) || "S".equals(desc) || "C".equals(desc)) {
                intValue = Integer.parseInt(raw);
            } else {
                throw new IllegalArgumentException("Only int-like static assumptions are supported: " + value);
            }
            return new StaticAssumption(owner, name, desc, intValue);
        }
    }
}
