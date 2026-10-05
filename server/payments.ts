import type Stripe from "stripe";
import { PACK_CENTS, PACK_CREDITS } from "./contracts.ts";
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
  if (
    full.payment_status !== "paid" ||
    full.status !== "complete" ||
    full.metadata?.app !== "marble-camera-studio" ||
    !full.metadata?.userId ||
    full.client_reference_id !== full.metadata.userId ||
    full.currency !== "usd" ||
    full.amount_total !== PACK_CENTS ||
    full.line_items?.has_more ||
    full.line_items?.data.length !== 1 ||
    full.line_items.data[0].price?.id !== priceId ||
    full.line_items.data[0].quantity !== 1
  ) {
    throw new Error("Payment does not match the configured credit pack");
  }
  ledger.creditPayment(full.metadata.userId, full.id, PACK_CREDITS);
}
