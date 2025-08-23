const { JVM } = require('./src/jvm.js');
const jre = require('./src/jre/index.js');

console.log('Testing JRE implementations...');

const jvm = new JVM();

// Test Math class methods
console.log('\n=== Testing Math class ===');
const mathClass = jre['java/lang/Math'];

if (mathClass) {
  const max = mathClass.staticMethods['max(II)I'];
  const result = max(jvm, null, [5, 3]);
  console.log('Math.max(5, 3) =', result);
  
  const abs = mathClass.staticMethods['abs(I)I'];
  const absResult = abs(jvm, null, [-5]);
  console.log('Math.abs(-5) =', absResult);
  
  const random = mathClass.staticMethods['random()D'];
  const randomResult = random(jvm, null, []);
  console.log('Math.random() =', randomResult);
} else {
  console.log('Math class not found!');
}

// Test Integer class methods
console.log('\n=== Testing Integer class ===');
const integerClass = jre['java/lang/Integer'];

if (integerClass) {
  const parseInt = integerClass.staticMethods['parseInt(Ljava/lang/String;)I'];
  const testString = { value: '123' };
  const parseResult = parseInt(jvm, null, [testString]);
  console.log('Integer.parseInt("123") =', parseResult);
  
  const toHexString = integerClass.staticMethods['toHexString(I)Ljava/lang/String;'];
  const hexResult = toHexString(jvm, null, [255]);
  console.log('Integer.toHexString(255) =', hexResult);
} else {
  console.log('Integer class not found!');
}

// Test Boolean class methods
console.log('\n=== Testing Boolean class ===');
const booleanClass = jre['java/lang/Boolean'];

if (booleanClass) {
  const parseBoolean = booleanClass.staticMethods['parseBoolean(Ljava/lang/String;)Z'];
  const trueString = { value: 'true' };
  const boolResult = parseBoolean(jvm, null, [trueString]);
  console.log('Boolean.parseBoolean("true") =', boolResult);
  
  const valueOf = booleanClass.staticMethods['valueOf(Ljava/lang/String;)Ljava/lang/Boolean;'];
  const boolObj = valueOf(jvm, null, [trueString]);
  console.log('Boolean.valueOf("true") =', boolObj.value, '(type:', boolObj.type + ')');
} else {
  console.log('Boolean class not found!');
}

console.log('\nTest completed!');