// The Electronic Mall (root module 160) on the host. Stores are TSN mail
// boxes (class Box, module 145) and products are letters in them, so the
// Mall speaks the mail messages, all cmd 37 `bbw+ [37, sub, sid, low, high]`:
// 32 store list, 19 a box's letter list, 25 read one letter, 31 get a
// letter as a Mall form (the product page; same reply layout as 25), 24
// deliver a letter (an order, `bbwwwawwawaaa`).
// Replies are cmd 37 (class 118: whichCmd @1, lowWord w4, highWord w6, data from 8).

import { encodeMessage } from './wire.js';

/**
 * @typedef {Object} MallProduct
 * @property {string} name  envelope `name` in the store's list, at most 9 characters
 * @property {string} title  first line of the order form
 * @property {string} blurb
 * @property {string} price
 */

/**
 * @typedef {Object} MallStore
 * @property {number} box  mail box number (lowWord; highWord 0)
 * @property {string} name  shown in the store list ("_" shows as a space)
 * @property {MallProduct[]} products
 */

const MAIL = 37;
export const MALL_SUB = Object.freeze({ STORES: 32, LETTERS: 19, DELIVER: 24, READ: 25, FORM: 31 });
/** Store record type the Mall keeps (module 160 handleMsg: type 4 = a store box). */
const STORE_TYPE = 4;
const NAME_FIELD = 10;
const TIME_FIELD = 6;
const READ_STATUS = 1;
/** Most copies the order form's number question accepts. */
const MAX_QUANTITY = 9;

/** @param {string} name @param {string} title @param {string} blurb @param {string} price @returns {MallProduct} */
function product(name, title, blurb, price) {
  return { name, title, blurb, price };
}

/** @type {readonly MallStore[]} */
export const DEFAULT_STORES = Object.freeze([
  {
    box: 101, name: 'Sierra_Software', products: [
      product('Red Baron', 'Red Baron', 'Fly the World War I skies over the Western Front. VGA, Sound Blaster.', '$59.95'),
      product('Yserbius', 'The Shadow of Yserbius', 'The TSN role-playing game on disk, with a strategy guide.', '$24.95'),
      product('KQ V', "King's Quest V", 'Absence Makes the Heart Go Yonder! 256-colour VGA.', '$69.95'),
      product('LSL 5', 'Leisure Suit Larry 5', 'Passionate Patti Does a Little Undercover Work.', '$59.95'),
    ],
  },
  {
    box: 102, name: 'TSN_Gear', products: [
      product('T-Shirt', 'TSN T-Shirt', '100% cotton, ImagiNation logo on the front. M, L, XL.', '$14.95'),
      product('Mug', 'TSN Coffee Mug', 'For those long nights online.', '$7.95'),
      product('Cap', 'TSN Baseball Cap', 'One size fits all.', '$11.95'),
    ],
  },
  {
    box: 103, name: 'Hint_Books', products: [
      product('KQ5 Hints', "King's Quest V Hint Book", 'Every puzzle, with maps.', '$9.95'),
      product('LSL Hints', 'Larry Hint Book', 'Larry 1-5 in one volume.', '$12.95'),
    ],
  },
]);

/**
 * A Mall order form (module 160 block 188): a title line, then questions,
 * each starting a line with `%`, optional digits and a type letter: t
 * true/false, d number (the digits are the maximum), s fill in the blank,
 * m multiple choice, c select. Real line breaks are dropped; `\n` breaks a
 * line, `\h` starts the help text. No question = "Invalid Order Form!".
 * @param {MallProduct} item @returns {string}
 */
export function orderForm({ title, blurb, price }) {
  return `${title}\n%t${blurb} ${price}. Add it to my order.\n%${MAX_QUANTITY}dHow many would you like?`;
}

/**
 * 37/32 reply: per store `w box low, w box high, b type 4, name\0`.
 * @param {number} toSid @param {readonly MallStore[]} stores @returns {Uint8Array}
 */
export function storeList(toSid, stores) {
  const head = encodeMessage('bbwww', [MAIL, MALL_SUB.STORES, toSid, 0, 0]);
  const records = stores.map((store) => encodeMessage('wwbs', [store.box, 0, STORE_TYPE, store.name]));
  return concat([head, ...records]);
}

/** @param {string} text @returns {number[]} exactly NAME_FIELD bytes, NUL-padded */
function field(text) {
  const bytes = [...text.slice(0, NAME_FIELD - 1)].map((ch) => ch.charCodeAt(0));
  return [...bytes, ...new Array(NAME_FIELD - bytes.length).fill(0)];
}

/**
 * One 47-byte envelope (class Envelope fromMsg, module 145 block 7): status b,
 * letter low w, letter high w, returnLo w, returnHi w, host[10], name[10],
 * appBits w, time[6], toName[10].
 * @param {MallProduct} product @param {number} letter @returns {number[]}
 */
function envelope(product, letter) {
  const head = Array.from(encodeMessage('bwwww', [READ_STATUS, letter, 0, 0, 0]));
  return [...head, ...field(''), ...field(product.name), 0, 0, ...new Array(TIME_FIELD).fill(0), ...field('')];
}

/**
 * 37/19 reply for box `box`: lowWord/highWord name the box, envelopes from 8.
 * @param {number} toSid @param {MallStore} store @returns {Uint8Array}
 */
export function letterList(toSid, store) {
  const head = encodeMessage('bbwww', [MAIL, MALL_SUB.LETTERS, toSid, store.box, 0]);
  return concat([head, Uint8Array.from(store.products.flatMap((product, i) => envelope(product, i + 1)))]);
}

/**
 * 37/25 or 37/31 reply: box w4/w6, letter w8/w10, the text from 12.
 * @param {number} sub MALL_SUB.READ or MALL_SUB.FORM
 * @param {number} toSid @param {MallStore} store @param {number} letter 1-based
 * @returns {Uint8Array}
 */
export function letterText(sub, toSid, store, letter) {
  const item = store.products[letter - 1];
  return encodeMessage('bbwwwwws', [MAIL, sub, toSid, store.box, 0, letter, 0, item ? orderForm(item) : '']);
}

/**
 * cmd 0 ok for 37/24: whichCmd 37 @4, whichSub 24 @5; the Mall says "Order
 * recieved by the Mall." (cmd 1 with the same pair is "Order NOT recieved").
 * @param {number} toSid @returns {Uint8Array}
 */
export function letterDelivered(toSid) {
  const OK = 0;
  return encodeMessage('bbwbb', [OK, 0, toSid, MAIL, MALL_SUB.DELIVER]);
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
function concat(parts) {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}
