class Stack {
  constructor() {
    this.items = [];
  }

  // Push an item onto the stack
  push(item) {
    this.items.push(item);
  }

  // Pop an item off the stack
  pop() {
    if (this.isEmpty()) {
      throw new Error("Stack underflow");
    }
    return this.items.pop();
  }

  // Peek at the top item of the stack without removing it
  peek() {
    if (this.isEmpty()) {
      throw new Error("Stack is empty");
    }
    return this.items[this.items.length - 1];
  }

  // Check if the stack is empty
  isEmpty() {
    return this.items.length === 0;
  }

  // Get the size of the stack
  size() {
    return this.items.length;
  }
}

module.exports = Stack;
