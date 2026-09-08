'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const { newFields, readField } = require('../src/core/objectModel');

for (const denseInstanceFields of [false, true]) {
  test(`sampled audio constructors store their state (dense=${denseInstanceFields})`, async (t) => {
    const jvm = new JVM({denseInstanceFields, jit: {compileWorker: false}});
    const make = async (name, descriptor, args) => {
      const type = `javax/sound/sampled/${name}`;
      await jvm.loadClassByName(type);
      const object = {type, fields: newFields(jvm, type)};
      jvm.jre[type].methods[`<init>${descriptor}`](jvm, object, args);
      return object;
    };
    const format = await make('AudioFormat', '(FIIZZ)V', [22050, 16, 2, true, false]);
    t.deepEqual(readField(format.fields, format.type), {
      sampleRate: 22050, sampleSizeInBits: 16, channels: 2, signed: true, bigEndian: false,
    }, 'AudioFormat retains the supplied PCM format');
    const lineClass = {type: 'java/lang/Class'};
    const info = await make('DataLine$Info',
      '(Ljava/lang/Class;[Ljavax/sound/sampled/AudioFormat;II)V',
      [lineClass, [format], 1024, 4096]);
    t.equal(jvm.jre['javax/sound/sampled/Line$Info'].methods['getLineClass()Ljava/lang/Class;'](jvm, info, []),
      lineClass, 'the superclass constructor retains the line class');
    t.equal(readField(info.fields, info.type).formats[0], format,
      'DataLine.Info retains the format identity');
    const mixer = await make('Mixer$Info',
      '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V',
      ['name', 'vendor', 'description', 'version']);
    t.equal(jvm.jre[mixer.type].methods['getName()Ljava/lang/String;'](jvm, mixer),
      'name', 'Mixer.Info reads the constructed metadata');
    t.end();
  });
}
