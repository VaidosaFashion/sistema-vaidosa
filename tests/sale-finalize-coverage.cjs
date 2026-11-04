'use strict';
// Migration map for the seven legacy finalization tests removed after combining
// the financial release with the durable-cart release. The old harness extracted
// an obsolete inline RPC handler; executing it would test code no longer shipped.
// No financial tests were removed: 19 correction + 7 payment + 6 delete tests remain.
module.exports = Object.freeze({
  'hidden select / invalid PIX reset': 'cart-draft-app.test.cjs: real app resets payment to Pendente and launches three consecutive sales without migration RPCs',
  'two consecutive sales': 'cart-draft-app.test.cjs: real app resets payment to Pendente and launches three consecutive sales without migration RPCs',
  'clear draft preserves next payment value': 'cart-draft-app.test.cjs: clearing with actual app resets payment and does not delete saved sales',
  'parallel finalization clicks and clear': 'cart-draft-ui.test.cjs: double-clicks and discard during send cannot change the in-flight request',
  'lost response replay without duplicate stock': 'cart-draft-ui.test.cjs: lost RPC response followed by unavailable lookup remains pending; reload reconciles without another write',
  // Deliberate safer contract: a generic SQL error cannot prove that an earlier
  // attempt did not commit. Only the narrowly verified first sales_pay_check
  // rejection may unlock; all other uncertain requests retain their UUID/payload.
  'generic SQL error formerly unlocked draft': 'cart-draft-ui.test.cjs: general SQL error with absent lookup does not allow a different request',
  'post-commit history failure cannot resend': 'cart-draft-ui.test.cjs: failed confirmation persistence keeps pending; screen refresh failure after confirmed does not resend'
});
