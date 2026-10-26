'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentState } = require('../src/document-state.js');

test('undoing a live edit recovers the exact preceding unsaved source representation', () => {
  const state = new DocumentState();
  state.load('old\n', 'old\n');
  const source = 'new  \nline\r\n';
  state.input(source, true);
  state.observe('new\nline\n');
  state.input('new!\nline\n');
  state.input('new\nline\n');
  assert.equal(state.text, source);
  assert.equal(state.dirty, true);
});

test('loading a new file clears remembered source representations from the previous file', () => {
  const state = new DocumentState();
  state.load('- old formatting\r\n', '* same\n');
  state.observe('* same\n');
  state.load('+ new formatting\n', '* same\n');
  state.input('* changed\n');
  state.input('* same\n');
  assert.equal(state.text, '+ new formatting\n');
  assert.equal(state.dirty, false);
});
