module.exports = {
    super: 'java/lang/Object',
    interfaces: ['java/util/Iterator'],
    fields: {
        list: 'Ljava/util/LinkedList;',
        index: 'I'
    },
    methods: {
        '<init>(Ljava/util/LinkedList;)V': (jvm, obj, args) => {
            obj.list = args[0].list; // Get the underlying JS array
            obj.index = 0;
        },
        'hasNext()Z': (jvm, obj, args) => {
            return obj.index < obj.list.length ? 1 : 0;
        },
        'next()Ljava/lang/Object;': (jvm, obj, args) => {
            if (obj.index < obj.list.length) {
                return obj.list[obj.index++];
            }
            throw { type: 'java/util/NoSuchElementException' };
        }
    }
};
