import { it } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { Ledger } from "../server/ledger.ts";
import { fulfillCheckout } from "../server/payments.ts";
import { CREDIT_PACKS, checkoutPack } from "../server/contracts.ts";

const checkout = () =>
  ({
    id: "cs_test_pack",
    status: "complete",
    payment_status: "paid",
    client_reference_id: "buyer",
    currency: "usd",
    amount_total: 500,
    metadata: { app: "marble-camera-studio", userId: "buyer" },
    line_items: {
      has_more: false,
      data: [{ quantity: 1, price: { id: "price_pack" } }],
    },
  }) as unknown as Stripe.Checkout.Session;

it("verifies settled Checkout details and credits duplicate deliveries exactly once", async () => {
  const ledger = new Ledger(":memory:");
  ledger.account("buyer", "verified-hash");
  const session = checkout();
  const stripe = {
    checkout: { sessions: { retrieve: async () => session } },
  } as unknown as Stripe;
  await fulfillCheckout(stripe, ledger, session, "price_pack");
  await fulfillCheckout(stripe, ledger, session, "price_pack");
  assert.equal(ledger.getAccount("buyer").credits, 6);
  ledger.close();
});

it("rejects incorrect price, amount, user, quantity, currency, and unpaid re-fetch", async () => {
  const mutations = [
    { amount_total: 1 },
    { currency: "eur" },
    { client_reference_id: "other" },
    { payment_status: "unpaid" },
    { line_items: { data: [{ quantity: 2, price: { id: "price_pack" } }] } },
    { line_items: { data: [{ quantity: 1, price: { id: "price_other" } }] } },
  ];
  for (const mutation of mutations) {
    const ledger = new Ledger(":memory:");
    ledger.account("buyer", "verified-hash");
    const session = checkout();
    const stripe = {
      checkout: {
        sessions: { retrieve: async () => ({ ...session, ...mutation }) },
      },
    } as unknown as Stripe;
    await assert.rejects(
      fulfillCheckout(stripe, ledger, session, "price_pack"),
    );
    assert.equal(ledger.getAccount("buyer").credits, 3);
    ledger.close();
  }
});

it("ignores other products and verifies signed payloads against tampering", async () => {
  const ledger = new Ledger(":memory:");
  const session = { ...checkout(), metadata: { app: "other-app" } };
  const neverRetrieve = {
    checkout: {
      sessions: {
        retrieve: async () => {
          throw new Error("must not fetch unrelated Checkout");
        },
      },
    },
  } as unknown as Stripe;
  await fulfillCheckout(
    neverRetrieve,
    ledger,
    session as Stripe.Checkout.Session,
    "price_pack",
  );
  const stripe = new Stripe("sk_test_fixture");
  const payload = JSON.stringify({
    id: "evt_fixture",
    type: "checkout.session.completed",
    data: { object: checkout() },
  });
  const secret = "whsec_fixture_only";
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  assert.equal(
    stripe.webhooks.constructEvent(payload, signature, secret).id,
    "evt_fixture",
  );
  assert.throws(() =>
    stripe.webhooks.constructEvent(
      payload.replace("500", "100"),
      signature,
      secret,
    ),
  );
  ledger.close();
});

it("credits each fixed pack once and reverses its full credit count without replay", async () => {
  for (const pack of CREDIT_PACKS) {
    const ledger = new Ledger(":memory:");
    ledger.account("buyer", "verified-phone");
    const session = {
      ...checkout(),
      id: "cs_" + pack.id,
      amount_total: pack.priceCents,
      metadata: {
        app: "marble-camera-studio",
        userId: "buyer",
        packId: pack.id,
      },
      line_items: {
        has_more: false,
        data: [{ quantity: pack.quantity, price: { id: "price_pack" } }],
      },
    } as unknown as Stripe.Checkout.Session;
    const stripe = {
      checkout: { sessions: { retrieve: async () => session } },
    } as unknown as Stripe;
    await fulfillCheckout(stripe, ledger, session, "price_pack");
    await fulfillCheckout(stripe, ledger, session, "price_pack");
    assert.equal(ledger.getAccount("buyer").credits, 3 + pack.credits);
    ledger.reversePayment(session.id);
    ledger.reversePayment(session.id);
    await fulfillCheckout(stripe, ledger, session, "price_pack");
    assert.equal(ledger.getAccount("buyer").credits, 3);
    ledger.close();
  }
});

it("rejects tampered pack selection and mismatched paid bundle totals", async () => {
  assert.equal(
    checkoutPack({}).id,
    "starter",
    "old clients still select the original pack",
  );
  for (const pack of CREDIT_PACKS)
    assert.deepEqual(checkoutPack({ packId: pack.id }), pack);
  for (const input of [
    { packId: "unknown" },
    { packId: "bulk", credits: 600 },
    { quantity: 20 },
    { priceCents: 1 },
    null,
  ])
    assert.throws(() => checkoutPack(input));
  for (const mutation of [
    {
      amount_total: 500,
      line_items: { data: [{ quantity: 20, price: { id: "price_pack" } }] },
    },
    {
      amount_total: 10000,
      line_items: { data: [{ quantity: 4, price: { id: "price_pack" } }] },
    },
    {
      metadata: {
        app: "marble-camera-studio",
        userId: "buyer",
        packId: "studio",
      },
    },
    {
      line_items: {
        has_more: true,
        data: [{ quantity: 1, price: { id: "price_pack" } }],
      },
    },
  ]) {
    const ledger = new Ledger(":memory:");
    ledger.account("buyer", "verified-phone");
    const session = checkout();
    const stripe = {
      checkout: {
        sessions: { retrieve: async () => ({ ...session, ...mutation }) },
      },
    } as unknown as Stripe;
    await assert.rejects(
      fulfillCheckout(stripe, ledger, session, "price_pack"),
    );
    assert.equal(ledger.getAccount("buyer").credits, 3);
    ledger.close();
  }
});
