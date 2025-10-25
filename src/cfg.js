/**
 * Represents a Control Flow Graph (CFG) for a single method.
 */
class CFG {
  /**
   * @param {string} entryBlockId - The ID of the first block to be executed.
   */
  constructor(entryBlockId) {
    /**
     * A map of block IDs to BasicBlock instances.
     * @type {Map<string, BasicBlock>}
     */
    this.blocks = new Map();

    /**
     * The ID of the entry block.
     * @type {string}
     */
    this.entryBlockId = entryBlockId;
  }

  /**
   * Adds a block to the CFG.
   * @param {BasicBlock} block - The block to add.
   */
  addBlock(block) {
    this.blocks.set(block.id, block);
  }

  /**
   * Adds a directed edge between two blocks.
   * @param {string} fromId - The ID of the source block.
   * @param {string} toId - The ID of the target block.
   */
  addEdge(fromId, toId) {
    const fromBlock = this.blocks.get(fromId);
    const toBlock = this.blocks.get(toId);
    if (fromBlock && toBlock) {
      fromBlock.successors.push(toId);
      toBlock.predecessors.push(fromId);
    }
  }

  /**
   * Converts the CFG to a serializable plain object.
   * @returns {object} A serializable representation of the CFG.
   */
  toJSON() {
    const blocksAsObject = {};
    for (const [id, block] of this.blocks.entries()) {
      blocksAsObject[id] = block.toJSON();
    }
    return {
      entryBlockId: this.entryBlockId,
      blocks: blocksAsObject,
    };
  }
}

/**
 * Represents a Basic Block in the CFG, a sequence of instructions
 * with no jumps in or out, except at the beginning and end.
 */
class BasicBlock {
  /**
   * @param {string} id - A unique identifier for the block (e.g., 'block_0').
   */
  constructor(id) {
    /**
     * The unique identifier for this block.
     * @type {string}
     */
    this.id = id;

    /**
     * The list of instruction objects from the AST's codeItems.
     * @type {Array<object>}
     */
    this.instructions = [];

    /**
     * An array of block IDs that can be executed after this block.
     * @type {Array<string>}
     */
    this.successors = [];

    /**
     * An array of block IDs that can lead to this block.
     * @type {Array<string>}
     */
    this.predecessors = [];
  }

  /**
   * Adds an instruction to the end of the block.
   * @param {object} instruction - The instruction object from the AST.
   */
  addInstruction(instruction) {
    this.instructions.push(instruction);
  }

  /**
   * Converts the BasicBlock to a serializable plain object.
   * @returns {object} A serializable representation of the BasicBlock.
   */
  toJSON() {
    return {
      id: this.id,
      instructions: this.instructions,
      successors: this.successors,
      predecessors: this.predecessors,
    };
  }
}

module.exports = {
  CFG,
  BasicBlock,
};
