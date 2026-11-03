// Host-side state of networked objects (Obj joinNet SIDs): their properties
// (client 13 word list, 14 string) and group membership (client 10 / 11).
// Pure data; HostLogic turns it into replies.

/**
 * @typedef {Object} StoredProperty
 * @property {number | string} value
 * @property {boolean} isString
 */

/** @param {Uint8Array} message @param {number} offset @returns {number} */
export function wordAt(message, offset) {
  return message[offset] | (message[offset + 1] << 8);
}

/** @param {Uint8Array} message @param {number} offset @returns {string} */
export function stringAt(message, offset) {
  const end = message.indexOf(0, offset);
  return String.fromCharCode(...message.subarray(offset, end < 0 ? message.length : end));
}

export class HostObjects {
  constructor() {
    /** @type {Map<number, Map<number, StoredProperty>>} sid -> offset -> value */
    this.properties = new Map();
    /** @type {Map<number, number[]>} group sid -> member sids */
    this.groups = new Map();
    /** @type {Set<number>} offsets ever set as strings */
    this.stringOffsets = new Set();
  }

  /** @param {number} sid @param {number} offset @param {number | string} value */
  setProperty(sid, offset, value) {
    const isString = typeof value === 'string';
    if (isString) {
      this.stringOffsets.add(offset);
    }
    const props = this.properties.get(sid) ?? new Map();
    this.properties.set(sid, new Map([...props, [offset, { value, isString }]]));
  }

  /** @param {number} sid @param {number} offset @returns {number | string} */
  property(sid, offset) {
    return this.properties.get(sid)?.get(offset)?.value ?? (this.isStringProperty(offset) ? '' : 0);
  }

  /** @param {number} offset @returns {boolean} */
  isStringProperty(offset) {
    return this.stringOffsets.has(offset);
  }

  /** @param {number} group @param {number} who @returns {number[]} members after joining */
  join(group, who) {
    const members = [...this.members(group).filter((sid) => sid !== who), who];
    this.groups.set(group, members);
    return members;
  }

  /** @param {number} group @param {number} who */
  leave(group, who) {
    this.groups.set(group, this.members(group).filter((sid) => sid !== who));
  }

  /** @param {number} group @returns {number[]} */
  members(group) {
    return this.groups.get(group) ?? [];
  }
}
