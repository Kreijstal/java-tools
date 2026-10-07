'use strict';
// Port of make/src/classes/build/tools/jfr/GenerateJfrFiles.java, which turns
// src/hotspot/share/jfr/metadata/metadata.xml into the JFR headers HotSpot
// compiles (--mode headers) and the metadata blob jdk.jfr reads (--mode
// metadata). The Java tool validates the XML against metadata.xsd first; this
// port only checks well-formedness and the type references verify() checks.
const fs = require('fs');
const path = require('path');
const { parseXml } = require('./xml');

class IllegalArgument extends Error {}

class XmlType {
  constructor(name, fieldType, parameterType, javaType, contentType, unsigned) {
    Object.assign(this, { name, fieldType, parameterType, javaType, contentType, unsigned });
  }
}

class TypeElement {
  constructor() {
    this.fields = [];
    this.name = null;
    this.javaType = null;
    this.label = '';
    this.description = '';
    this.category = '';
    this.thread = false;
    this.stackTrace = false;
    this.startTime = false;
    this.period = '';
    this.cutoff = false;
    this.throttle = false;
    this.level = '';
    this.experimental = false;
    this.internal = false;
    this.id = 0;
    this.isEvent = false;
    this.isRelation = false;
    this.supportStruct = false;
    this.commitState = null;
    this.primitive = false;
  }

  persist(pos) {
    pos.writeInt(this.fields.length);
    for (const f of this.fields) f.persist(pos);
    pos.writeUTF(this.javaType);
    pos.writeUTF(this.label);
    pos.writeUTF(this.description);
    pos.writeUTF(this.category);
    pos.writeBoolean(this.thread);
    pos.writeBoolean(this.stackTrace);
    pos.writeBoolean(this.startTime);
    pos.writeUTF(this.period);
    pos.writeBoolean(this.cutoff);
    pos.writeBoolean(this.throttle);
    pos.writeUTF(this.level);
    pos.writeBoolean(this.experimental);
    pos.writeBoolean(this.internal);
    pos.writeLong(this.id);
    pos.writeBoolean(this.isEvent);
    pos.writeBoolean(this.isRelation);
  }
}

class TypeCounter {
  constructor(startId) { this.first = startId; this.last = -1; this.count = 0; this.id = -1; }
  next() {
    this.id = this.id === -1 ? this.first : this.id + 1;
    this.count++;
    this.last = this.id;
    return this.id;
  }
}

const RESERVED_EVENT_COUNT = 2;

class FieldElement {
  constructor(metadata) {
    this.metadata = metadata;
    this.type = null;
    this.name = null;
    this.typeName = null;
    this.constantPool = true;
    this.transition = null;
    this.contentType = null;
    this.label = null;
    this.description = null;
    this.relation = null;
    this.experimental = false;
    this.unsigned = false;
    this.array = false;
    this.annotations = null;
    this.struct = false;
  }

  persist(pos) {
    pos.writeUTF(this.name);
    pos.writeUTF(this.type.javaType);
    pos.writeUTF(this.label);
    pos.writeUTF(this.description);
    pos.writeBoolean(this.constantPool);
    pos.writeBoolean(this.array);
    pos.writeBoolean(this.unsigned);
    pos.writeUTF(this.annotations);
    pos.writeUTF(this.transition);
    pos.writeUTF(this.relation);
    pos.writeBoolean(this.experimental);
  }

  getParameterType() {
    if (this.struct) return `const JfrStruct${this.typeName}&`;
    const xmlType = this.metadata.xmlTypes.get(this.typeName);
    if (xmlType) return xmlType.parameterType;
    return this.type != null ? 'u8' : this.typeName;
  }

  getParameterName() { return this.struct ? 'value' : 'new_value'; }

  getFieldType() {
    if (this.struct) return `JfrStruct${this.typeName}`;
    const xmlType = this.metadata.xmlTypes.get(this.typeName);
    if (xmlType) return xmlType.fieldType;
    return this.type != null ? 'u8' : this.typeName;
  }
}

const getString = (attrs, name) => (attrs.has(name) ? attrs.get(name) : '');
// Boolean.valueOf(String)
const getBoolean = (attrs, name, dflt) => (attrs.has(name) ? attrs.get(name).toLowerCase() === 'true' : dflt);

class Metadata {
  constructor(xmlFile) {
    this.types = new Map();
    this.xmlTypes = new Map();
    this.xmlContentTypes = new Map();
    this.eventCounter = null;
    this.typeCounter = null;
    let currentType = null, currentField = null;
    parseXml(fs.readFileSync(xmlFile, 'utf8'), {
      startElement: (qName, attributes) => {
        switch (qName) {
          case 'XmlContentType': {
            const n = attributes.get('name');
            this.xmlContentTypes.set(n, { name: n, annotation: attributes.get('annotation') });
            break;
          }
          case 'XmlType': {
            const name = attributes.get('name');
            this.xmlTypes.set(name, new XmlType(name, attributes.get('fieldType'), attributes.get('parameterType'),
              getString(attributes, 'javaType'), getString(attributes, 'contentType'),
              getBoolean(attributes, 'unsigned', false)));
            break;
          }
          case 'Relation':
          case 'Type':
          case 'Event':
            currentType = new TypeElement();
            currentType.name = attributes.get('name');
            currentType.label = getString(attributes, 'label');
            currentType.description = getString(attributes, 'description');
            currentType.category = getString(attributes, 'category');
            currentType.experimental = getBoolean(attributes, 'experimental', false);
            currentType.internal = getBoolean(attributes, 'internal', false);
            currentType.thread = getBoolean(attributes, 'thread', false);
            currentType.stackTrace = getBoolean(attributes, 'stackTrace', false);
            currentType.startTime = getBoolean(attributes, 'startTime', true);
            currentType.period = getString(attributes, 'period');
            currentType.cutoff = getBoolean(attributes, 'cutoff', false);
            currentType.level = getString(attributes, 'level');
            currentType.throttle = getBoolean(attributes, 'throttle', false);
            currentType.commitState = getString(attributes, 'commitState');
            currentType.isEvent = qName === 'Event';
            currentType.isRelation = qName === 'Relation';
            break;
          case 'Field':
            currentField = new FieldElement(this);
            currentField.name = attributes.get('name');
            currentField.typeName = attributes.get('type');
            currentField.label = getString(attributes, 'label');
            currentField.description = getString(attributes, 'description');
            currentField.contentType = getString(attributes, 'contentType');
            currentField.struct = getBoolean(attributes, 'struct', false);
            currentField.array = getBoolean(attributes, 'array', false);
            currentField.transition = getString(attributes, 'transition');
            currentField.relation = getString(attributes, 'relation');
            currentField.experimental = getBoolean(attributes, 'experimental', false);
            break;
          default:
        }
      },
      endElement: (qName) => {
        switch (qName) {
          case 'Relation':
          case 'Type':
          case 'Event':
            this.types.set(currentType.name, currentType);
            currentType = null;
            break;
          case 'Field':
            currentType.fields.push(currentField);
            currentField = null;
            break;
          default:
        }
      },
    }, xmlFile);
  }

  persist(pos) {
    pos.writeInt(this.types.size);
    for (const t of this.types.values()) t.persist(pos);
  }

  getList(pred) { return [...this.types.values()].filter(pred); }
  getEvents() { return this.getList((t) => t.isEvent); }
  getPeriodicEvents() { return this.getList((t) => t.isEvent && t.period !== ''); }
  getTypes() { return this.getList((t) => !t.isEvent); }
  getStructs() { return this.getList((t) => !t.isEvent && t.supportStruct); }

  verify() {
    for (const t of this.types.values()) {
      for (const f of t.fields) {
        if (!this.xmlTypes.has(f.typeName) && !this.types.has(f.typeName)) {
          throw new Error(`Could not find definition of type '${f.typeName}' used by ${t.name}#${f.name}`);
        }
      }
    }
  }

  wireUpTypes() {
    // Add Java primitives
    for (const [name, xmlType] of this.xmlTypes) {
      // Excludes Thread and Class
      if (!this.types.has(name)) {
        // Excludes u8, u4, u2, u1, Ticks and Ticksspan
        if (xmlType.javaType !== '' && !xmlType.unsigned) {
          const te = new TypeElement();
          te.name = name;
          te.javaType = xmlType.javaType;
          te.primitive = true;
          this.types.set(te.name, te);
        }
      }
    }
    // Setup Java fully qualified names
    for (const t of this.types.values()) {
      if (t.isEvent) {
        t.javaType = `jdk.${t.name}`;
      } else {
        const xmlType = this.xmlTypes.get(t.name);
        t.javaType = xmlType && xmlType.javaType !== '' ? xmlType.javaType : `jdk.types.${t.name}`;
      }
    }
    // Setup content type, annotation, constant pool etc. for fields.
    for (const t of this.types.values()) {
      for (const f of t.fields) {
        let type = this.types.get(f.typeName);
        const xmlType = this.xmlTypes.get(f.typeName);
        if (type === undefined) {
          if (xmlType === undefined) throw new Error('Unknown type');
          if (f.contentType === '') f.contentType = xmlType.contentType;
          type = this.types.get(xmlType.javaType);
          if (type === undefined) throw new Error('NullPointerException');
        }
        if (type.primitive) f.constantPool = false;
        if (xmlType !== undefined) f.unsigned = xmlType.unsigned;
        if (f.struct) {
          f.constantPool = false;
          type.supportStruct = true;
        }
        f.type = type;
        const xmlContentType = this.xmlContentTypes.get(f.contentType);
        f.annotations = xmlContentType === undefined ? '' : xmlContentType.annotation;
        if (f.relation !== '') f.relation = `jdk.types.${f.relation}`;
      }
    }
    // Low numbers for event so most of them
    // can fit in one byte with compressed integers
    this.eventCounter = new TypeCounter(RESERVED_EVENT_COUNT);
    for (const t of this.getEvents()) t.id = this.eventCounter.next();
    this.typeCounter = new TypeCounter(this.eventCounter.last + 1);
    for (const t of this.getTypes()) t.id = this.typeCounter.next();
  }

  getName(id) {
    for (const t of this.types.values()) if (t.id === id) return t.name;
    throw new Error(`Unexpected id ${id}`);
  }
}

class Printer {
  constructor(outputFile) {
    this.file = outputFile;
    this.parts = [];
    this.write('/* AUTOMATICALLY GENERATED FILE - DO NOT EDIT */');
    this.write('');
  }
  write(text) { this.parts.push(text, '\n'); } // Don't use Windows line endings
  close() { fs.writeFileSync(this.file, this.parts.join(''), 'utf8'); }
}

function withPrinter(file, body) {
  const out = new Printer(file);
  body(out);
  out.close();
}

function printJfrPeriodicHpp(metadata, outputFile) {
  withPrinter(outputFile, (out) => {
    out.write('#ifndef JFRFILES_JFRPERIODICEVENTSET_HPP');
    out.write('#define JFRFILES_JFRPERIODICEVENTSET_HPP');
    out.write('');
    out.write('#include "utilities/macros.hpp"');
    out.write('#if INCLUDE_JFR');
    out.write('#include "jfrfiles/jfrEventIds.hpp"');
    out.write('#include "memory/allocation.hpp"');
    out.write('');
    out.write('enum PeriodicType {BEGIN_CHUNK, INTERVAL, END_CHUNK};');
    out.write('');
    out.write('class JfrPeriodicEventSet : public AllStatic {');
    out.write(' public:');
    out.write('  static void requestEvent(JfrEventId id, jlong timestamp, PeriodicType periodicType) {');
    out.write('    _timestamp = Ticks(timestamp);');
    out.write('    _type = periodicType;');
    out.write('    switch(id) {');
    out.write('  ');
    for (const e of metadata.getPeriodicEvents()) {
      out.write(`      case Jfr${e.name}Event:`);
      out.write(`        request${e.name}();`);
      out.write('        break;');
      out.write('  ');
    }
    out.write('      default:');
    out.write('        break;');
    out.write('      }');
    out.write('    }');
    out.write('');
    out.write(' private:');
    out.write('');
    for (const e of metadata.getPeriodicEvents()) {
      out.write(`  static void request${e.name}(void);`);
      out.write('');
    }
    out.write(' static Ticks timestamp(void);');
    out.write(' static Ticks _timestamp;');
    out.write(' static PeriodicType type(void);');
    out.write(' static PeriodicType _type;');
    out.write('};');
    out.write('');
    out.write('#endif // INCLUDE_JFR');
    out.write('#endif // JFRFILES_JFRPERIODICEVENTSET_HPP');
  });
}

function printJfrEventControlHpp(metadata, outputFile) {
  withPrinter(outputFile, (out) => {
    out.write('#ifndef JFRFILES_JFR_NATIVE_EVENTSETTING_HPP');
    out.write('#define JFRFILES_JFR_NATIVE_EVENTSETTING_HPP');
    out.write('');
    out.write('#include "utilities/macros.hpp"');
    out.write('#if INCLUDE_JFR');
    out.write('#include "jfrfiles/jfrEventIds.hpp"');
    out.write('');
    out.write('/**');
    out.write(' * Event setting. We add some padding so we can use our');
    out.write(' * event IDs as indexes into this.');
    out.write(' */');
    out.write('');
    out.write('struct jfrNativeEventSetting {');
    out.write('  jlong  threshold_ticks;');
    out.write('  jlong  miscellaneous;');
    out.write('  u1     stacktrace;');
    out.write('  u1     enabled;');
    out.write('  u1     large;');
    out.write('  u1     pad[5]; // Because GCC on linux ia32 at least tries to pack this.');
    out.write('};');
    out.write('');
    out.write('union JfrNativeSettings {');
    out.write('  // Array version.');
    out.write('  jfrNativeEventSetting bits[NUMBER_OF_EVENTS + NUMBER_OF_RESERVED_EVENTS];');
    out.write('  // Then, to make it easy to debug,');
    out.write('  // add named struct members also.');
    out.write('  struct {');
    out.write('    jfrNativeEventSetting pad[NUMBER_OF_RESERVED_EVENTS];');
    for (const t of metadata.getEvents()) out.write(`    jfrNativeEventSetting ${t.name};`);
    out.write('  } ev;');
    out.write('};');
    out.write('');
    out.write('#endif // INCLUDE_JFR');
    out.write('#endif // JFRFILES_JFR_NATIVE_EVENTSETTING_HPP');
  });
}

const jfrEventId = (name) => `Jfr${name}Event`;
const jfrTypeId = (name) => `TYPE_${name.toUpperCase()}`;

function printJfrEventIdsHpp(metadata, outputFile) {
  withPrinter(outputFile, (out) => {
    out.write('#ifndef JFRFILES_JFREVENTIDS_HPP');
    out.write('#define JFRFILES_JFREVENTIDS_HPP');
    out.write('');
    out.write('#include "utilities/macros.hpp"');
    out.write('#if INCLUDE_JFR');
    out.write('');
    out.write('enum JfrEventId {');
    out.write('  JfrMetadataEvent = 0,');
    out.write('  JfrCheckpointEvent = 1,');
    for (const t of metadata.getEvents()) out.write(`  ${jfrEventId(t.name)} = ${t.id},`);
    out.write('};');
    out.write('typedef enum JfrEventId JfrEventId;');
    out.write('');
    const first = metadata.getName(metadata.eventCounter.first);
    const last = metadata.getName(metadata.eventCounter.last);
    out.write(`static const JfrEventId FIRST_EVENT_ID = ${jfrEventId(first)};`);
    out.write(`static const JfrEventId LAST_EVENT_ID = ${jfrEventId(last)};`);
    out.write(`static const int NUMBER_OF_EVENTS = ${metadata.eventCounter.count};`);
    out.write(`static const int NUMBER_OF_RESERVED_EVENTS = ${RESERVED_EVENT_COUNT};`);
    out.write('#endif // INCLUDE_JFR');
    out.write('#endif // JFRFILES_JFREVENTIDS_HPP');
  });
}

function printJfrTypesHpp(metadata, outputFile) {
  withPrinter(outputFile, (out) => {
    out.write('#ifndef JFRFILES_JFRTYPES_HPP');
    out.write('#define JFRFILES_JFRTYPES_HPP');
    out.write('');
    out.write('#include "utilities/macros.hpp"');
    out.write('#if INCLUDE_JFR');
    out.write('');
    out.write('#include <string.h>');
    out.write('#include "memory/allocation.hpp"');
    out.write('');
    out.write('enum JfrTypeId {');
    for (const type of metadata.getTypes()) out.write(`  ${jfrTypeId(type.name)} = ${type.id},`);
    out.write('};');
    out.write('');
    const first = metadata.getName(metadata.typeCounter.first);
    const last = metadata.getName(metadata.typeCounter.last);
    out.write(`static const JfrTypeId FIRST_TYPE_ID = ${jfrTypeId(first)};`);
    out.write(`static const JfrTypeId LAST_TYPE_ID = ${jfrTypeId(last)};`);
    out.write('');
    out.write('class JfrType : public AllStatic {');
    out.write(' public:');
    out.write('  static jlong name_to_id(const char* type_name) {');
    const javaTypes = new Map();
    for (const xmlType of metadata.xmlTypes.values()) {
      if (xmlType.javaType !== '') javaTypes.set(xmlType.javaType, xmlType);
    }
    for (const xmlType of javaTypes.values()) {
      out.write(`    if (strcmp(type_name, "${xmlType.javaType}") == 0) {`);
      out.write(`      return TYPE_${xmlType.name.toUpperCase()};`);
      out.write('    }');
    }
    out.write('    return -1;');
    out.write('  }');
    out.write('};');
    out.write('');
    out.write('#endif // INCLUDE_JFR');
    out.write('#endif // JFRFILES_JFRTYPES_HPP');
  });
}

function printJfrEventClassesHpp(metadata, outputFile) {
  withPrinter(outputFile, (out) => {
    out.write('#ifndef JFRFILES_JFREVENTCLASSES_HPP');
    out.write('#define JFRFILES_JFREVENTCLASSES_HPP');
    out.write('');
    out.write('#include "jfrfiles/jfrTypes.hpp"');
    out.write('#include "jfr/utilities/jfrTypes.hpp"');
    out.write('#include "oops/klass.hpp"');
    out.write('#include "runtime/thread.hpp"');
    out.write('#include "utilities/macros.hpp"');
    out.write('#include "utilities/ticks.hpp"');
    out.write('#if INCLUDE_JFR');
    out.write('#include "jfr/recorder/service/jfrEvent.hpp"');
    out.write('/*');
    out.write(' * Each event class has an assert member function verify() which is invoked');
    out.write(' * just before the engine writes the event and its fields to the data stream.');
    out.write(' * The purpose of verify() is to ensure that all fields in the event are initialized');
    out.write(' * and set before attempting to commit.');
    out.write(' *');
    out.write(' * We enforce this requirement because events are generally stack allocated and therefore');
    out.write(' * *not* initialized to default values. This prevents us from inadvertently committing');
    out.write(' * uninitialized values to the data stream.');
    out.write(' *');
    out.write(' * The assert message contains both the index (zero based) as well as the name of the field.');
    out.write(' */');
    out.write('');
    printTypes(out, metadata, false);
    printHelpers(out, false);
    out.write('');
    out.write('');
    out.write('#else // !INCLUDE_JFR');
    out.write('');
    out.write('template <typename T>');
    out.write('class JfrEvent {');
    out.write(' public:');
    out.write('  JfrEvent() {}');
    out.write('  void set_starttime(const Ticks&) const {}');
    out.write('  void set_endtime(const Ticks&) const {}');
    out.write('  bool should_commit() const { return false; }');
    out.write('  bool is_started() const { return false; }');
    out.write('  static bool is_enabled() { return false; }');
    out.write('  void commit() {}');
    out.write('};');
    out.write('');
    printTypes(out, metadata, true);
    printHelpers(out, true);
    out.write('');
    out.write('');
    out.write('#endif // INCLUDE_JFR');
    out.write('#endif // JFRFILES_JFREVENTCLASSES_HPP');
  });
}

function printHelpers(out, empty) {
  out.write('template <typename EventType>');
  out.write('class JfrNonReentrant : public EventType {');
  if (!empty) {
    out.write(' private:');
    out.write('  Thread* const _thread;');
    out.write('  int32_t _previous_nesting;');
  }
  out.write(' public:');
  out.write('  JfrNonReentrant(EventStartTime timing = TIMED)');
  if (empty) {
    out.write('  {}');
  } else {
    out.write('    : EventType(timing), _thread(Thread::current()), _previous_nesting(JfrThreadLocal::make_non_reentrant(_thread)) {}');
    out.write('');
    out.write('  JfrNonReentrant(Thread* thread, EventStartTime timing = TIMED)');
    out.write('    : EventType(timing), _thread(thread), _previous_nesting(JfrThreadLocal::make_non_reentrant(_thread)) {}');
  }
  if (!empty) {
    out.write('');
    out.write('  ~JfrNonReentrant() {');
    out.write('    if (_previous_nesting != -1) {');
    out.write('      JfrThreadLocal::make_reentrant(_thread, _previous_nesting);');
    out.write('    }');
    out.write('  }');
  }
  out.write('}; ');
}

function printTypes(out, metadata, empty) {
  for (const t of metadata.getStructs()) {
    printType(out, t, empty);
    out.write('');
  }
  for (const e of metadata.getEvents()) {
    printEvent(out, e, empty);
    out.write('');
  }
}

function printType(out, t, empty) {
  out.write(`struct JfrStruct${t.name}`);
  out.write('{');
  if (!empty) {
    out.write(' private:');
    for (const f of t.fields) printField(out, f);
    out.write('');
  }
  out.write(' public:');
  for (const f of t.fields) printTypeSetter(out, f, empty);
  out.write('');
  if (!empty) printWriteData(out, t);
  out.write('};');
  out.write('');
}

function printEvent(out, event, empty) {
  out.write(`class Event${event.name} : public JfrEvent<Event${event.name}>`);
  out.write('{');
  if (!empty) {
    out.write(' private:');
    for (const f of event.fields) printField(out, f);
    out.write('');
  }
  out.write(' public:');
  if (!empty) {
    out.write(`  static const bool hasThread = ${event.thread};`);
    out.write(`  static const bool hasStackTrace = ${event.stackTrace};`);
    out.write(`  static const bool isInstant = ${!event.startTime};`);
    out.write(`  static const bool hasCutoff = ${event.cutoff};`);
    out.write(`  static const bool hasThrottle = ${event.throttle};`);
    out.write(`  static const bool isRequestable = ${event.period !== ''};`);
    out.write(`  static const JfrEventId eventId = Jfr${event.name}Event;`);
    out.write('');
  }
  if (!empty) {
    out.write(`  Event${event.name}(EventStartTime timing=TIMED) : JfrEvent<Event${event.name}>(timing) {}`);
  } else {
    out.write(`  Event${event.name}(EventStartTime timing=TIMED) {}`);
  }
  out.write('');
  let index = 0;
  for (const f of event.fields) {
    out.write(`  void set_${f.name}(${f.getParameterType()} ${f.getParameterName()}) {`);
    if (!empty) {
      out.write(`    this->_${f.name} = ${f.getParameterName()};`);
      out.write(`    DEBUG_ONLY(set_field_bit(${index++}));`);
    }
    out.write('  }');
  }
  out.write('');
  if (!empty) {
    printWriteData(out, event);
    out.write('');
  }
  out.write(`  using JfrEvent<Event${event.name}>::commit; // else commit() is hidden by overloaded versions in this class`);
  if (event.fields.length) {
    printConstructor2(out, event, empty);
    printCommitMethod(out, event, empty);
  }
  if (!empty) printVerify(out, event.fields);
  out.write('};');
}

function printWriteData(out, type) {
  out.write('  template <typename Writer>');
  out.write('  void writeData(Writer& w) {');
  if (type.isEvent && type.internal) out.write('    JfrEventSetting::unhide_internal_types();');
  for (const field of type.fields) {
    if (field.struct) out.write(`    _${field.name}.writeData(w);`);
    else out.write(`    w.write(_${field.name});`);
  }
  out.write('  }');
}

function printTypeSetter(out, field, empty) {
  if (!empty) {
    out.write(`  void set_${field.name}(${field.getParameterType()} new_value) { this->_${field.name} = new_value; }`);
  } else {
    out.write(`  void set_${field.name}(${field.getParameterType()} new_value) { }`);
  }
}

function printVerify(out, fields) {
  out.write('');
  out.write('#ifdef ASSERT');
  out.write('  void verify() const {');
  let index = 0;
  for (const f of fields) {
    out.write(`    assert(verify_field_bit(${index++}), "Attempting to write an uninitialized event field: %s", "_${f.name}");`);
  }
  out.write('  }');
  out.write('#endif');
}

function printCommitMethod(out, event, empty) {
  if (event.startTime) {
    const sj = event.fields.map((f) => `${f.getParameterType()} ${f.name}`).join(',\n              ');
    out.write('');
    out.write(`  void commit(${sj}) {`);
    if (!empty) {
      out.write('    if (should_commit()) {');
      for (const f of event.fields) out.write(`      set_${f.name}(${f.name});`);
      out.write('      commit();');
      out.write('    }');
    }
    out.write('  }');
  }
  // Avoid clash with static commit() method
  if (!event.fields.length) return;
  out.write('');
  const sj = [];
  if (event.startTime) {
    sj.push('const Ticks& startTicks');
    sj.push('const Ticks& endTicks');
  }
  for (const f of event.fields) sj.push(`${f.getParameterType()} ${f.name}`);
  out.write(`  static void commit(${sj.join(',\n                     ')}) {`);
  if (!empty) {
    out.write(`    Event${event.name} me(UNTIMED);`);
    out.write('');
    out.write('    if (me.should_commit()) {');
    if (event.startTime) {
      out.write('      me.set_starttime(startTicks);');
      out.write('      me.set_endtime(endTicks);');
    }
    for (const f of event.fields) out.write(`      me.set_${f.name}(${f.name});`);
    out.write('      me.commit();');
    out.write('    }');
  }
  out.write('  }');
}

function printConstructor2(out, event, empty) {
  if (!event.startTime) {
    out.write('');
    out.write('');
  }
  if (event.startTime) {
    out.write('');
    out.write(`  Event${event.name}(`);
    const sj = event.fields.map((f) => `${f.getParameterType()} ${f.name}`).join(',\n    ');
    if (!empty) {
      out.write(`    ${sj}) : JfrEvent<Event${event.name}>(TIMED) {`);
      out.write('    if (should_commit()) {');
      for (const f of event.fields) out.write(`      set_${f.name}(${f.name});`);
      out.write('    }');
    } else {
      out.write(`    ${sj}) {`);
    }
    out.write('  }');
  }
}

function printField(out, field) {
  out.write(`  ${field.getFieldType()} _${field.name};`);
}

// java.io.DataOutputStream
class DataOutput {
  constructor() { this.chunks = []; }
  writeInt(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.chunks.push(b); }
  writeLong(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.chunks.push(b); }
  writeBoolean(v) { this.chunks.push(Buffer.from([v ? 1 : 0])); }
  writeUTF(s) {
    if (s === null || s === undefined) throw new Error('NullPointerException in writeUTF');
    // modified UTF-8
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 1 && c <= 0x7f) bytes.push(c);
      else if (c <= 0x7ff) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    if (bytes.length > 65535) throw new Error(`encoded string too long: ${bytes.length} bytes`);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(bytes.length);
    this.chunks.push(len, Buffer.from(bytes));
  }
  bytes() { return Buffer.concat(this.chunks); }
}

function printUsage(write) {
  write('Usage: java GenerateJfrFiles[.java]');
  write(' --mode <headers|metadata>');
  write(' --xml <path-to-metadata.xml> ');
  write(' --xsd <path-to-metadata.xsd>');
  write(' --output <output-file-or-directory>');
}

function consumeOption(option, argList) {
  const index = argList.indexOf(option);
  if (index >= 0 && index <= argList.length - 2) {
    const result = argList[index + 1];
    argList.splice(index, 2);
    return result;
  }
  throw new IllegalArgument(`missing option ${option}`);
}

function main(args) {
  const err = (s) => process.stderr.write(`${s}\n`);
  try {
    const argList = args.slice();
    const mode = consumeOption('--mode', argList);
    const output = consumeOption('--output', argList);
    const xml = consumeOption('--xml', argList);
    consumeOption('--xsd', argList);
    if (argList.length) throw new IllegalArgument(`unknown option [${argList.join(', ')}]`);
    if (mode !== 'headers' && mode !== 'metadata') throw new IllegalArgument(`No enum constant OutputMode.${mode}`);

    const metadata = new Metadata(xml);
    metadata.verify();
    metadata.wireUpTypes();

    if (mode === 'headers') {
      printJfrEventIdsHpp(metadata, path.join(output, 'jfrEventIds.hpp'));
      printJfrTypesHpp(metadata, path.join(output, 'jfrTypes.hpp'));
      printJfrPeriodicHpp(metadata, path.join(output, 'jfrPeriodic.hpp'));
      printJfrEventControlHpp(metadata, path.join(output, 'jfrEventControl.hpp'));
      printJfrEventClassesHpp(metadata, path.join(output, 'jfrEventClasses.hpp'));
    } else {
      const b = new DataOutput();
      metadata.persist(b);
      fs.writeFileSync(output, b.bytes());
    }
    return 0;
  } catch (e) {
    if (e instanceof IllegalArgument) {
      err('');
      err(`GenerateJfrFiles: ${e.message}`);
      err('');
      printUsage(err);
      err('');
    } else {
      err(e.stack || String(e));
    }
  }
  return 1;
}

module.exports = { main };
