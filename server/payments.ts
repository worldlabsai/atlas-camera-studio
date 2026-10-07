import type Stripe from "stripe";
import { CREDIT_PACKS } from "./contracts.ts";
import type { Ledger } from "./ledger.ts";

export async function fulfillCheckout(
  stripe: Pick<Stripe, "checkout">,
  ledger: Ledger,
  session: Stripe.Checkout.Session,
  priceId: string,
) {
  if (
    session.metadata?.app !== "marble-camera-studio" ||
    session.payment_status !== "paid" ||
    session.status !== "complete"
  )
    return;
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items"],
  });
  const item = full.line_items?.data[0];
  const pack = CREDIT_PACKS.find(
    (candidate) => candidate.quantity === item?.quantity,
  );
  if (
    !pack ||
    (full.metadata?.packId && full.metadata.packId !== pack.id) ||
    full.payment_status !== "paid" ||
    full.status !== "complete" ||
    full.metadata?.app !== "marble-camera-studio" ||
    !full.metadata?.userId ||
    full.client_reference_id !== full.metadata.userId ||
    full.currency !== "usd" ||
    full.amount_total !== pack.priceCents ||
    full.line_items?.has_more ||
    full.line_items?.data.length !== 1 ||
    full.line_items.data[0].price?.id !== priceId
  ) {
    throw new Error("Payment does not match the configured credit pack");
  }
  ledger.creditPayment(full.metadata.userId, full.id, pack.credits);
}
