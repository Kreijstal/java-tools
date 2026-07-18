module.exports = {
  super: 'java/lang/Object',
  staticMethods: {
    'isRightMouseButton(Ljava/awt/event/MouseEvent;)Z': (jvm, obj, args) => {
      const event = args[0];
      return event && event.button === 3 ? 1 : 0;
    },
  },
};
