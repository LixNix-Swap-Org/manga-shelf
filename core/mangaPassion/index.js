// Manga Passion in core: every function takes the ctx first (services/mangaPassion/ binds the server's).
const client = require('./client');
const classify = require('./classify');
const gaps = require('./gaps');
const autofill = require('./autofill');
const releases = require('./releases');

module.exports = { client, classify, gaps, autofill, releases };
