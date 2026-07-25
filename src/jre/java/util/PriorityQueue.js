const { withThrows } = require('../../helpers');

module.exports = {
  super: {
    type: 'java/util/AbstractQueue'
  },
  methods: {
    '<init>()V': (jvm, obj, args, thread) => {
      obj.heap = [];
      obj.size = 0;
      obj.comparator = null; // Natural ordering
    },
    '<init>(Ljava/util/Comparator;)V': (jvm, obj, args, thread) => {
      obj.heap = [];
      obj.size = 0;
      obj.comparator = args[0];
    },
    '<init>(I)V': (jvm, obj, args, thread) => {
      obj.heap = new Array(args[0]); // initial capacity ignored in simple impl
      obj.size = 0;
      obj.comparator = null;
    },
    'add(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const item = args[0];
      return obj.methods['offer(Ljava/lang/Object;)Z'].call(null, jvm, obj, [item]) ? 1 : 0;
    },
    'offer(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      const item = args[0];
      obj.heap.push(item);
      obj.size++;
      obj.bubbleUp(obj.heap.length - 1);
      return 1; // always succeeds
    },
    'poll()Ljava/lang/Object;': (jvm, obj, args) => {
      if (obj.size === 0) return null;

      const item = obj.heap[0];
      obj.heap[0] = obj.heap[obj.size - 1];
      obj.heap.pop();
      obj.size--;

      if (obj.size > 0) {
        obj.sinkDown(0);
      }

      return item;
    },
    'peek()Ljava/lang/Object;': (jvm, obj, args) => {
      return obj.size > 0 ? obj.heap[0] : null;
    },
    'size()I': (jvm, obj, args) => {
      return obj.size;
    },
    'isEmpty()Z': (jvm, obj, args) => {
      return obj.size === 0 ? 1 : 0;
    },
    'contains(Ljava/lang/Object;)Z': (jvm, obj, args) => {
      return obj.heap.includes(args[0]) ? 1 : 0;
    },
    'clear()V': (jvm, obj, args) => {
      obj.heap = [];
      obj.size = 0;
    },
    'iterator()Ljava/util/Iterator;': (jvm, obj, args) => {
      let index = 0;
      return {
        type: 'java/util/Iterator',
        hasNext: () => index < obj.size,
        next: withThrows(() => {
          if (index >= obj.size) {
            throw {
              type: 'java/util/NoSuchElementException',
              message: 'No more elements'
            };
          }
          return obj.heap[index++];
        }, ['java/util/NoSuchElementException'])
      };
    },
    // Helper methods
    bubbleUp: function(index) {
      while (index > 0) {
        const parentIndex = Math.floor((index - 1) / 2);
        if (this.compare(this.heap[index], this.heap[parentIndex]) < 0) {
          [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
          index = parentIndex;
        } else {
          break;
        }
      }
    },
    sinkDown: function(index) {
      while (true) {
        const leftIndex = 2 * index + 1;
        const rightIndex = 2 * index + 2;
        let smallest = index;

        if (leftIndex < this.size && this.compare(this.heap[leftIndex], this.heap[smallest]) < 0) {
          smallest = leftIndex;
        }
        if (rightIndex < this.size && this.compare(this.heap[rightIndex], this.heap[smallest]) < 0) {
          smallest = rightIndex;
        }

        if (smallest !== index) {
          [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
          index = smallest;
        } else {
          break;
        }
      }
    },
    compare: function(a, b) {
      if (this.comparator && this.comparator.methods && this.comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I']) {
        try {
          return this.comparator.methods['compare(Ljava/lang/Object;Ljava/lang/Object;)I'](null, this.comparator, [a, b]);
        } catch (e) {
          // Fall back to natural ordering
        }
      }

      // Natural ordering for numbers and strings
      if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
      }
      if (typeof a === 'string' && typeof b === 'string') {
        return a.localeCompare(b);
      }
      // Default compare
      return a - b || 0;
    }
  },
  staticFields: {}
};
