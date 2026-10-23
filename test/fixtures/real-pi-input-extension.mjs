// Real Pi extension using its native RPC UI; no simulated harness events.
export default function (pi) {
  let asked = false;
  pi.on("agent_start", async (_event, ctx) => {
    if (asked) return;
    asked = true;
    const answer = await ctx.ui.input("HS ordinary technical input test", "Reply HS_INPUT_OK");
    if (answer !== "HS_INPUT_OK") throw new Error("Unexpected technical test answer");
  });
}
