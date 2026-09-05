import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.MethodNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class ReplaceMethodBody {
    private ReplaceMethodBody() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 5) {
            System.err.println("Usage: ReplaceMethodBody <target.class> <donor.class> <name> <desc> <output.class>");
            System.exit(2);
        }

        Path targetPath = Paths.get(args[0]);
        Path donorPath = Paths.get(args[1]);
        String name = args[2];
        String desc = args[3];
        Path outputPath = Paths.get(args[4]);

        ClassNode target = readClass(targetPath);
        ClassNode donor = readClass(donorPath);

        MethodNode targetMethod = findMethod(target, name, desc);
        MethodNode donorMethod = findMethod(donor, name, desc);
        if (targetMethod == null) {
            throw new IllegalArgumentException("Target method not found: " + name + desc);
        }
        if (donorMethod == null) {
            throw new IllegalArgumentException("Donor method not found: " + name + desc);
        }

        targetMethod.instructions = donorMethod.instructions;
        targetMethod.tryCatchBlocks = donorMethod.tryCatchBlocks;
        targetMethod.localVariables = donorMethod.localVariables;
        targetMethod.visibleLocalVariableAnnotations = donorMethod.visibleLocalVariableAnnotations;
        targetMethod.invisibleLocalVariableAnnotations = donorMethod.invisibleLocalVariableAnnotations;
        targetMethod.maxStack = donorMethod.maxStack;
        targetMethod.maxLocals = donorMethod.maxLocals;

        ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
        target.accept(writer);
        Files.createDirectories(outputPath.toAbsolutePath().getParent());
        Files.write(outputPath, writer.toByteArray());
    }

    private static ClassNode readClass(Path path) throws Exception {
        ClassNode classNode = new ClassNode();
        new ClassReader(Files.readAllBytes(path)).accept(classNode, 0);
        return classNode;
    }

    private static MethodNode findMethod(ClassNode classNode, String name, String desc) {
        for (MethodNode method : classNode.methods) {
            if (name.equals(method.name) && desc.equals(method.desc)) {
                return method;
            }
        }
        return null;
    }
}
