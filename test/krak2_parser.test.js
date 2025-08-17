const test = require('tape');
const { Lang } = require('../src/krak2_parser.js');
const P = require('parsimmon');

test("Parser tests", (t) => {
    t.test("WORD Parser Tests", (t) => {
      const wordParser = Lang.WORD;

      t.test("parses a valid WORD starting with a letter", (t) => {
        const input = "myVariable";
        const result = wordParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "myVariable");
        t.end();
      });

      t.test("parses a valid WORD starting with an underscore", (t) => {
        const input = "_privateVar";
        const result = wordParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "_privateVar");
        t.end();
      });

      t.test("parses a valid WORD starting with a dollar sign", (t) => {
        const input = "$special";
        const result = wordParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "$special");
        t.end();
      });

      t.test("parses a valid WORD starting with a parenthesis", (t) => {
        const input = "(init)";
        const result = wordParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "(init)");
        t.end();
      });

      t.test("parses a valid WORD starting with a less than sign", (t) => {
        const input = "<clinit>";
        const result = wordParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "<clinit>");
        t.end();
      });

      t.test(
        "parses a valid WORD starting with [ followed by an uppercase letter",
        (t) => {
          const input = "[Ljava/lang/String;";
          const result = wordParser.parse(input);
          t.ok(result.status, "Parsing should be successful");
          t.equal(result.value, "[Ljava/lang/String;");
          t.end();
        }
      );

      t.test(
        "parses a valid WORD starting with [ followed by another [",
        (t) => {
          const input = "[[I";
          const result = wordParser.parse(input);
          t.ok(result.status, "Parsing should be successful");
          t.equal(result.value, "[[I");
          t.end();
        }
      );

      t.test(
        "fails to parse a WORD starting with [ followed by a lowercase letter",
        (t) => {
          const input = "[myRef]";
          const result = wordParser.parse(input);
          t.notOk(result.status, "Parsing should fail");
          t.end();
        }
      );

      t.test(
        "fails to parse a WORD starting with [ followed by a digit",
        (t) => {
          const input = "[123]";
          const result = wordParser.parse(input);
          t.notOk(result.status, "Parsing should fail");
          t.end();
        }
      );
    });

    t.test("REF Parser Tests", (t) => {
      const refParser = Lang.REF;

      t.test("parses a valid REF", (t) => {
        const input = "[my_ref]";
        const result = refParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "[my_ref]");
        t.end();
      });

      t.end();
    });

    t.test("BSREF Parser Tests", (t) => {
      const bsrefParser = Lang.BSREF;

      t.test("parses a valid BSREF", (t) => {
        const input = "[bs:bootstrap_ref]";
        const result = bsrefParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "[bs:bootstrap_ref]");
        t.end();
      });

      t.end();
    });

    t.test("LABEL_DEF Parser Tests", (t) => {
      const labelDefParser = Lang.LABEL_DEF;

      t.test("parses a valid LABEL_DEF", (t) => {
        const input = "L1:";
        const result = labelDefParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "L1:");
        t.end();
      });

      t.end();
    });

    t.test("STRING_LITERAL Parser Tests", (t) => {
      const stringLiteralParser = Lang.STRING_LITERAL;

      t.test("parses a double-quoted string literal", (t) => {
        const input = '"Hello World!"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, '"Hello World!"');
        t.end();
      });

      t.test("parses a single-quoted string literal", (t) => {
        const input = "'Hello World!'";
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "'Hello World!'");
        t.end();
      });

      t.test("parses a raw byte string literal", (t) => {
        const input = 'b"raw\\x00bytes"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, 'b"raw\\x00bytes"');
        t.end();
      });

      t.end();
    });

    t.test("INT_LITERAL Parser Tests", (t) => {
      const intLiteralParser = Lang.INT_LITERAL;

      t.test("parses a decimal integer", (t) => {
        const input = "123";
        const result = intLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "123");
        t.end();
      });

      t.test("parses a hexadecimal integer", (t) => {
        const input = "0xcafe";
        const result = intLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "0xcafe");
        t.end();
      });

      t.test("parses a negative integer", (t) => {
        const input = "-42";
        const result = intLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "-42");
        t.end();
      });

      t.end();
    });

    t.test("DOUBLE_LITERAL Parser Tests", (t) => {
      const doubleLiteralParser = Lang.DOUBLE_LITERAL;

      t.test("parses positive Infinity", (t) => {
        const input = "+Infinity";
        const result = doubleLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "+Infinity");
        t.end();
      });

      t.test("parses negative Infinity", (t) => {
        const input = "-Infinity";
        const result = doubleLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "-Infinity");
        t.end();
      });

      t.test("parses positive NaN with specific binary representation", (t) => {
        const input = "+NaN<0x7ff0123456789abc>";
        const result = doubleLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "+NaN<0x7ff0123456789abc>");
        t.end();
      });

      t.test("parses decimal double", (t) => {
        const input = "3.14159";
        const result = doubleLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "3.14159");
        t.end();
      });

      t.test("fails to parse NaN with incorrect hex digit count", (t) => {
        const input = "-NaN<0x123456789abc>"; // Only 13 digits instead of 16
        const result = doubleLiteralParser.parse(input);
        t.notOk(result.status, "Parsing should fail");
        t.end();
      });

      t.end();
    });

    t.test("LONG_LITERAL Parser Tests", (t) => {
      const longLiteralParser = Lang.LONG_LITERAL;

      t.test("parses a decimal long integer", (t) => {
        const input = "123L";
        const result = longLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "123L");
        t.end();
      });

      t.test("parses a hexadecimal long integer", (t) => {
        const input = "-0x1afL";
        const result = longLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "-0x1afL");
        t.end();
      });

      t.end();
    });

    t.test("FLOAT_LITERAL Parser Tests", (t) => {
      const floatLiteralParser = Lang.FLOAT_LITERAL;

      t.test("parses a decimal float with 'f' suffix", (t) => {
        const input = "3.14f";
        const result = floatLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "3.14f");
        t.end();
      });

      t.test("parses a float with exponent and 'f' suffix", (t) => {
        const input = "-1.0e-5f";
        const result = floatLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "-1.0e-5f");
        t.end();
      });

      t.test("parses positive Infinity with 'f' suffix", (t) => {
        const input = "+Infinityf";
        const result = floatLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "+Infinityf");
        t.end();
      });

      t.test("parses negative NaN with specific binary representation", (t) => {
        const input = "-NaN<0xFFABCDEF>f";
        const result = floatLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "-NaN<0xFFABCDEF>f");
        t.end();
      });

      t.test("fails to parse NaN with incorrect hex digit count", (t) => {
        const input = "+NaN<0xABCDEF>f"; // Only 6 digits instead of 8
        const result = floatLiteralParser.parse(input);
        t.notOk(result.status, "Parsing should fail");
        t.end();
      });

      t.end();
    });

    t.test("STRING_LITERAL Parser Tests (with escapes)", (t) => {
      const stringLiteralParser = Lang.STRING_LITERAL;

      t.test("parses a string literal with escape sequences", (t) => {
        const input = '"Hello\\nWorld\\t!"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, '"Hello\\nWorld\\t!"');
        t.end();
      });

      t.test("parses a string literal with Unicode escape sequences", (t) => {
        const input = '"Unicode char: \\u263A"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, '"Unicode char: \\u263A"');
        t.end();
      });

      t.test("parses a string literal with 32-bit Unicode escape", (t) => {
        const input = '"Unicode char: \\U0001F600"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, '"Unicode char: \\U0001F600"');
        t.end();
      });

      t.test("parses a raw byte string with byte escape", (t) => {
        const input = 'b"Raw bytes: \\xFF\\x00"';
        const result = stringLiteralParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, 'b"Raw bytes: \\xFF\\x00"');
        t.end();
      });

      t.test("fails to parse string with invalid escape sequence", (t) => {
        const input = '"Invalid escape: \\z"';
        const result = stringLiteralParser.parse(input);
        t.notOk(result.status, "Parsing should fail");
        t.end();
      });

      t.end();
    });

    t.test("lbl Parser Tests", (t) => {
      const lblParser = Lang.lbl;

      t.test("parses a valid lbl", (t) => {
        const input = "Label1";
        const result = lblParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.equal(result.value, "Label1");
        t.end();
      });

      t.test("fails to parse an invalid lbl", (t) => {
        const input = "label1";
        const result = lblParser.parse(input);
        t.notOk(result.status, "Parsing should fail");
        t.end();
      });

      t.end();
    });

    t.test("Code Item Parser", (t) => {
      const codeItemParser = Lang.code_item;

      t.test("parses an instruction line without a label", (t) => {
        const input = `ldc "Hello World!"`;
        const result = codeItemParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.deepEqual(result.value, { op: "ldc", arg: '"Hello World!"' });
        t.end();
      });

      t.test("parses an instruction line with a label", (t) => {
        const input = `L1: goto L2`;
        const result = codeItemParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.deepEqual(result.value, {
          labelDef: "L1:",
          instruction: {
            op: "goto",
            arg: "L2"
          }
        });
        t.end();
      });

      t.test("parses a label without an instruction", (t) => {
        const input = `LEND:`;
        const result = codeItemParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.deepEqual(result.value, {
          labelDef: "LEND:",
          instruction: null
        });
        t.end();
      });

      t.test("parses a code directive", (t) => {
        const input = `.catch java/lang/Exception from L1 to L2 using L3`;
        const result = codeItemParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.deepEqual(result.value, {
          type: "catch",
          clsref: "java/lang/Exception",
          fromLbl: "L1",
          toLbl: "L2",
          usingLbl: "L3"
        });
        t.end();
      });
    });

    t.test("Code Attribute Parser", (t) => {
      const codeAttrParser = Lang.code_attr;

      t.test("parses a basic code attribute", (t) => {
        const input = `stack 13 locals 13
getstatic Field java/lang/System out Ljava/io/PrintStream;
.end code`;
        const result = codeAttrParser.parse(input);
        t.ok(result.status, "Parsing should be successful");
        t.deepEqual(result.value, {
          long: false,
          stackSize: "13",
          localsSize: "13",
          codeItems: [
            {
              op: "getstatic",
              arg: [
                "Field",
                "java/lang/System",
                ["out", "Ljava/io/PrintStream;"]
              ]
            }
          ],
          attributes: []
        });
        t.end();
      });
    });

    t.test("Parses .linenumbertable attribute", (t) => {
      const lineNumberTableInput = `.linenumbertable
            L0 12
            L5 13
            L21 15
            L28 17
            L31 16
            L32 18
        .end linenumbertable`;

      const expectedLineNumberTable = {
        type: "linenumbertable",
        lines: [
          { label: "L0", lineNumber: "12" },
          { label: "L5", lineNumber: "13" },
          { label: "L21", lineNumber: "15" },
          { label: "L28", lineNumber: "17" },
          { label: "L31", lineNumber: "16" },
          { label: "L32", lineNumber: "18" }
        ]
      };

      const result = Lang.attrbody.parse(lineNumberTableInput);
      t.ok(result.status, "Parsing should be successful");
      t.deepEqual(
          result.value,
          expectedLineNumberTable,
          "Parsed linenumbertable structure should match expected"
        );
      t.end();
    });


    t.test("Parses a complete source file", (t) => {
      const input = `.version 55 0
.class public super MainApp
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
L0:     aload_0
L1:     invokespecial Method java/lang/Object <init> ()V
L4:     return
L5:
        .linenumbertable
            L0 1
        .end linenumbertable
    .end code
.end method

.method public static main : ([Ljava/lang/String;)V
    .code stack 2 locals 3
L0:     new ThingProducer
L3:     dup
L4:     invokespecial Method ThingProducer <init> ()V
L7:     astore_1
L8:     aload_1
L9:     ldc "MyThing"
L11:    invokevirtual Method ThingProducer produceThing (Ljava/lang/String;)LThing;
L14:    astore_2
L15:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L18:    aload_2
L19:    invokevirtual Method Thing getName ()Ljava/lang/String;
L22:    invokedynamic [_8]
L27:    invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
L30:    return
L31:
        .linenumbertable
            L0 3
            L8 4
            L15 5
            L30 6
        .end linenumbertable
    .end code
.end method
.sourcefile "MainApp.java"
.innerclasses
    java/lang/invoke/MethodHandles$Lookup java/lang/invoke/MethodHandles Lookup public static final
.end innerclasses
;.bootstrapmethods
;.const [_8] = InvokeDynamic invokeStatic Method java/lang/invoke/StringConcatFactory makeConcatWithConstants (Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite; String "Produced a thing with name: \u0001" : makeConcatWithConstants (Ljava/lang/String;)Ljava/lang/String;
.end class
`;


      const expected = {
        classes: [
          {
            version: [{ major: "55", minor: "0" }],
            flags: ["public", "super"],
            className: "MainApp",
            superClass: "java/lang/Object",
            interfaces: [],
            items: [
              {
                type: "method",
                method: {
                  flags: ["public"],
                  name: "<init>",
                  descriptor: "()V",
                  attributes: [
                    {
                      type: "code",
                      code: {
                        long: false,
                        stackSize: "1",
                        localsSize: "1",
                        codeItems: [
                          { labelDef: "L0:", instruction: "aload_0" },
                          {
                            labelDef: "L1:",
                            instruction: {
                              op: "invokespecial",
                              arg: [
                                "Method",
                                "java/lang/Object",
                                ["<init>", "()V"]
                              ]
                            }
                          },
                          { labelDef: "L4:", instruction: "return" },
                          { labelDef: "L5:", instruction: null }
                        ],
                        attributes: [
                          {
                            type: "linenumbertable",
                            lines: [{ label: "L0", lineNumber: "1" }]
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              {
                type: "method",
                method: {
                  flags: ["public", "static"],
                  name: "main",
                  descriptor: "([Ljava/lang/String;)V",
                  attributes: [
                    {
                      type: "code",
                      code: {
                        long: false,
                        stackSize: "2",
                        localsSize: "3",
                        codeItems: [
                          {
                            labelDef: "L0:",
                            instruction: { op: "new", arg: "ThingProducer" }
                          },
                          { labelDef: "L3:", instruction: "dup" },
                          {
                            labelDef: "L4:",
                            instruction: {
                              op: "invokespecial",
                              arg: [
                                "Method",
                                "ThingProducer",
                                ["<init>", "()V"]
                              ]
                            }
                          },
                          { labelDef: "L7:", instruction: "astore_1" },
                          { labelDef: "L8:", instruction: "aload_1" },
                          {
                            labelDef: "L9:",
                            instruction: { op: "ldc", arg: '"MyThing"' }
                          },
                          {
                            labelDef: "L11:",
                            instruction: {
                              op: "invokevirtual",
                              arg: [
                                "Method",
                                "ThingProducer",
                                ["produceThing", "(Ljava/lang/String;)LThing;"]
                              ]
                            }
                          },
                          { labelDef: "L14:", instruction: "astore_2" },
                          {
                            labelDef: "L15:",
                            instruction: {
                              op: "getstatic",
                              arg: [
                                "Field",
                                "java/lang/System",
                                ["out", "Ljava/io/PrintStream;"]
                              ]
                            }
                          },
                          { labelDef: "L18:", instruction: "aload_2" },
                          {
                            labelDef: "L19:",
                            instruction: {
                              op: "invokevirtual",
                              arg: [
                                "Method",
                                "Thing",
                                ["getName", "()Ljava/lang/String;"]
                              ]
                            }
                          },
                          {
                            labelDef: "L22:",
                            instruction: { op: "invokedynamic", arg: "[_8]" }
                          },
                          {
                            labelDef: "L27:",
                            instruction: {
                              op: "invokevirtual",
                              arg: [
                                "Method",
                                "java/io/PrintStream",
                                ["println", "(Ljava/lang/String;)V"]
                              ]
                            }
                          },
                          { labelDef: "L30:", instruction: "return" },
                          { labelDef: "L31:", instruction: null }
                        ],
                        attributes: [
                          {
                            type: "linenumbertable",
                            lines: [
                              { label: "L0", lineNumber: "3" },
                              { label: "L8", lineNumber: "4" },
                              { label: "L15", lineNumber: "5" },
                              { label: "L30", lineNumber: "6" }
                            ]
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              {
                type: "attribute",
                attribute: {
                  type: "sourcefile",
                  value: '"MainApp.java"'
                }
              },
              {
                type: "attribute",
                attribute: {
                  type: "innerclasses",
                  classes: [
                    {
                      innerCls: "java/lang/invoke/MethodHandles$Lookup",
                      outerCls: "java/lang/invoke/MethodHandles",
                      innerName: "Lookup",
                      flags: ["public", "static", "final"]
                    }
                  ]
                }
              }
            ]
          }
        ]
      };

      const result = Lang.source_file.parse(input);
      t.ok(result.status, "Parsing should be successful");
      t.deepEqual(
          result.value,
          expected,
          "Parsed source file structure should match expected"
        );
      t.end();
    });
});
