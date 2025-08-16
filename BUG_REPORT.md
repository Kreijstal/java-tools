# Bug Report: `jvm-parser` Fails to Expose `BootstrapMethods` Attribute

## Description

The `jvm-parser` library, a dependency of this project, does not correctly parse class files that contain `invokedynamic` instructions. Specifically, it fails to expose the mandatory `BootstrapMethods` attribute at the top level of the parsed class file object. This makes it impossible for the downstream JVM implementation to correctly link and execute `invokedynamic` instructions.

## The Problem

When an `invokedynamic` instruction is present in a class file, the Java Virtual Machine Specification mandates that the class file *must* contain a `BootstrapMethods` attribute in its class-level attributes table. This attribute contains the information needed to link the `invokedynamic` call site.

The `jvm-parser` library correctly parses the `invokedynamic` instruction itself, but it does not make the `BootstrapMethods` attribute available in the top-level `attributes` array of the JSON object it produces. This was confirmed by adding logging to `src/convert_tree.js` and inspecting the object produced by `jvm-parser` for the `TestMethods.class` file, which is known to contain `invokedynamic`. The `attributes` array on the `inputJson` object was `undefined`.

This leads to a crash when trying to implement `invokedynamic` support, as the necessary bootstrap method information cannot be found.

## Steps to Reproduce

1.  Attempt to implement `invokedynamic` in `src/instructions/invoke.js` and `src/convert_tree.js`.
2.  In `src/convert_tree.js`, when handling the `invokedynamic` instruction, attempt to access `inputJson.attributes` to find the `BootstrapMethods` attribute.
3.  Run the `test/KrakatauWorkspace.test.js` test suite, which loads `TestMethods.class`.
4.  The code will fail because `inputJson.attributes` is `undefined`.

## Expected Behavior

The `jvm-parser` library should produce a JSON object that includes a top-level `attributes` array containing the `BootstrapMethods` attribute if it is present in the class file.

## Actual Behavior

The `jvm-parser` library produces a JSON object where the `attributes` array is missing, even when the class file contains `invokedynamic` instructions and therefore must have a `BootstrapMethods` attribute.

## Conclusion

This is a bug in the downstream dependency `jvm-parser`. A bug report should be filed with the maintainers of that library. Until this is fixed, it is not possible to correctly implement `invokedynamic` support in this project.
