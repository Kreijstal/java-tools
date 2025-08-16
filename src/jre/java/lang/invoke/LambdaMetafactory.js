const { CallSite } = require('./index.js');

const LambdaMetafactory = {
  'java/lang/invoke/LambdaMetafactory.metafactory(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;': (jvm, frame, args) => {
    // args[0] is lookup, ignored for now
    // args[1] is invokedName (e.g., 'run')
    // args[2] is invokedType (e.g., '()Ljava/lang/Runnable;')
    // args[3] is samMethodType (e.g., '()V')
    // args[4] is implMethod (the MethodHandle for the lambda body, e.g., 'lambda$main$0')
    // args[5] is instantiatedMethodType (e.g., '()V')

    const implMethod = args[4];

    // The core of metafactory is to return a CallSite.
    // This CallSite's target is a MethodHandle that, when invoked, will execute the lambda body.
    // For our simulation, we can simplify this. We can create a CallSite
    // that directly holds the method handle to the lambda's implementation.
    const callSite = new CallSite(implMethod);

    // The metafactory returns the CallSite, which should be pushed onto the calling frame's stack.
    return callSite;
  },
};

module.exports = LambdaMetafactory;
