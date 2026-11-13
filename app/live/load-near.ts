// [CTO] T-036 · R4: wallet code is imported only here, in app/live/, lazily, when something is signed (the gate's loader).
// Shared by step 2 (create / timeout), the review auth (signReviewAuth) and step 3 (reveal / timeout).
export const loadNear = async () => ({ near: await import("near-api-js"), rpcErrors: await import("near-api-js/rpc-errors") });
