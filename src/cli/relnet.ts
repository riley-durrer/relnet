// relnet command line: start a deal with another company's agent.
//
//   invite     --side buyer|supplier --url <where the other agent will reach you> [--node URL] [--agreement 0x..] [--ttl-hours N]
//   join       <invite code> --confirm-fingerprint <fingerprint from the inviter, heard on another channel>
//   accept     <reply code> --deal <id> --confirm-fingerprint <fingerprint from the joiner, on another channel>
//   serve      --deal <id> --mandate <mandate.json> [--port N]          (the inviter's agent; waits for offers)
//   negotiate  --deal <id> --mandate <mandate.json>                      (the joiner's agent; opens the talks)
//
// The mandate file has the same shape as examples/companies/<name>/mandate.json. Keys and pins live in
// $RELNET_HOME (default ~/.relnet). Nothing here binds anyone: agreed terms still need two people to sign on-chain.
import { loadCompanyFile } from "./mandate-file.js";
import { startResponder, negotiateOverA2A } from "../channel/a2a.js";
import { summarizeTerms } from "../lib/terms.js";
import {
  DealFile, fingerprintMatches, freshIdentity, identityOf, InviteBody, loadDeal, localRelease, newDealId, newInvite, newReply,
  open, other, peerOf, readable, releaseDifferences, ReplyBody, saveDeal, seal, Side,
} from "./invite.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const positional = rest.find((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
const has = (n: string) => rest.includes(n);
function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}
const need = (v: string | undefined, name: string) => v ?? die(`missing ${name}`, 64);

async function invite() {
  const side = need(flag("--side"), "--side buyer|supplier") as Side;
  if (side !== "buyer" && side !== "supplier") die("--side must be buyer or supplier", 64);
  const url = need(flag("--url"), "--url");
  const { id, stored } = await freshIdentity();
  const dealId = newDealId();
  const release = await localRelease();
  const body = newInvite({ side, url, id, dealId, release, nodeUrl: flag("--node"), agreement: flag("--agreement"), ttlHours: flag("--ttl-hours") ? Number(flag("--ttl-hours")) : undefined });
  saveDeal({ dealId, side, identity: stored, ownUrl: url, release, network: body.network, agreement: body.agreement });
  console.log(await seal("invite", body, id));
  console.error(`\nDeal ${dealId}. You are the ${side}. Release ${release.version} (${release.commit.slice(0, 12)}).`);
  console.error(`Your agent key fingerprint:\n  ${readable(id.fingerprint)}`);
  console.error(`\nSend the invite code above to the other company. Then tell them this fingerprint over a DIFFERENT channel`);
  console.error(`(a phone call, or an email thread you already trust). They must type it back to pin you.`);
  console.error(`When they send back a reply code: relnet accept <reply> --deal ${dealId} --confirm-fingerprint <theirs>`);
}

async function join() {
  const code = need(positional, "<invite code>");
  const inv: InviteBody = await open("invite", code);
  const mine = await localRelease();
  const diff = releaseDifferences(mine, inv.release);
  console.error(`Invite for deal ${inv.dealId} from the ${inv.side}.`);
  console.error(`  agent URL     ${inv.agent.url}`);
  console.error(`  network       ${inv.network.nodeUrl ?? "(not stated)"}`);
  console.error(`  agreement     ${inv.agreement ?? "(none yet)"}`);
  console.error(`  their release ${inv.release.version} (${inv.release.commit.slice(0, 12)})`);
  console.error(`  their key     ${readable(inv.agent.fingerprint)}`);
  if (diff.length && !has("--allow-release-mismatch"))
    die(`\nREFUSED: you and the inviter are not running the same release (${diff.join("; ")}).\nInstall the release they named and run \`npm run verify\` on it, or pass --allow-release-mismatch if you accept that risk.`);
  if (diff.length) console.error(`\nWARNING: releases differ (${diff.join("; ")}).`);
  const typed = flag("--confirm-fingerprint");
  if (!typed) {
    console.error(`\nNOT PINNED. Ask the inviter, over a different channel than the one that carried this code, to read you their key fingerprint.`);
    console.error(`If it matches the "their key" line above, run this again with: --confirm-fingerprint <fingerprint>`);
    process.exit(2);
  }
  if (!fingerprintMatches(inv.agent.fingerprint, typed)) die(`REFUSED: that fingerprint does not match this invite's key. Someone may have swapped the invite.`);
  const side = other(inv.side);
  const { id, stored } = await freshIdentity();
  saveDeal({
    dealId: inv.dealId, side, identity: stored,
    peer: { fingerprint: inv.agent.fingerprint, publicJwk: inv.agent.publicJwk, url: inv.agent.url },
    release: mine, network: inv.network, agreement: inv.agreement,
  });
  console.log(await seal("reply", newReply({ side, id, dealId: inv.dealId }), id));
  console.error(`\nPinned the ${inv.side}'s agent. You are the ${side}. Your agent key fingerprint:\n  ${readable(id.fingerprint)}`);
  console.error(`Send the reply code above to the inviter and read them this fingerprint over a different channel.`);
  console.error(`Then run your agent: relnet negotiate --deal ${inv.dealId} --mandate <your mandate.json>`);
}

async function accept() {
  const rep: ReplyBody = await open("reply", need(positional, "<reply code>"));
  const d = loadDeal(need(flag("--deal"), "--deal"));
  if (rep.dealId !== d.dealId) die("REFUSED: this reply is for a different deal.");
  if (rep.side !== other(d.side)) die(`REFUSED: this reply claims to be the ${rep.side}, but you invited a ${other(d.side)}.`);
  if (d.peer) die("REFUSED: this deal already has a pinned counterparty.");
  console.error(`Reply for deal ${d.dealId} from the ${rep.side}.\n  their key  ${readable(rep.agent.fingerprint)}`);
  const typed = flag("--confirm-fingerprint");
  if (!typed) {
    console.error(`\nNOT PINNED. Compare that key with the fingerprint the joiner read you over a different channel, then re-run with --confirm-fingerprint <fingerprint>.`);
    process.exit(2);
  }
  if (!fingerprintMatches(rep.agent.fingerprint, typed)) die("REFUSED: that fingerprint does not match this reply's key.");
  saveDeal({ ...d, peer: { fingerprint: rep.agent.fingerprint, publicJwk: rep.agent.publicJwk } });
  console.error(`\nPinned the ${rep.side}'s agent. Run your agent: relnet serve --deal ${d.dealId} --mandate <your mandate.json>`);
}

function loadRun(): { d: DealFile; mandate: ReturnType<typeof loadCompanyFile>["mandate"] } {
  const d = loadDeal(need(flag("--deal"), "--deal"));
  const m = loadCompanyFile(need(flag("--mandate"), "--mandate"));
  if (m.side !== d.side) die(`REFUSED: this deal has you as the ${d.side}, but the mandate file is for a ${m.side}.`);
  return { d, mandate: m.mandate };
}
const finishWith = (d: DealFile, terms: Record<string, bigint>) => {
  saveDeal({ ...d, agreed: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, v.toString()])) });
  console.log(`\nAgreed terms (a person must read and sign these on-chain; the agents cannot):\n`);
  console.log(summarizeTerms(terms as any));
};

async function serve() {
  const { d, mandate } = loadRun();
  const peer = await peerOf(d);
  const ownUrl = d.ownUrl ?? die("this deal has no own URL (only the inviter serves)");
  const port = Number(flag("--port") ?? new URL(ownUrl).port ?? 4100) || 4100;
  const r = await startResponder({
    side: d.side, mandate, identity: await identityOf(d), peer, dealId: d.dealId, port, publicUrl: ownUrl, name: d.side,
    onEvent: (e) => console.log(`[${e.at.slice(11, 19)}] ${e.text}`),
  });
  console.log(`Serving deal ${d.dealId} as the ${d.side}, listening on 127.0.0.1:${port}, advertising ${ownUrl}`);
  console.log(`Plain HTTP on this machine only. Put a TLS proxy or tunnel in front of it for a remote counterparty. Ctrl-C to stop.`);
  for (;;) {
    await new Promise((res) => setTimeout(res, 500));
    const t = r.agreed();
    if (t) {
      finishWith(d, t as any);
      await r.close();
      return;
    }
  }
}

async function negotiate() {
  const { d, mandate } = loadRun();
  const peer = await peerOf(d);
  if (!peer.url) die("the counterparty has no URL (only the inviter's agent can be called)");
  const out = await negotiateOverA2A({
    side: d.side, mandate, identity: await identityOf(d), peer, dealId: d.dealId, name: d.side,
    onEvent: (e) => console.log(`[${e.at.slice(11, 19)}] ${e.text}`),
  });
  if (!out.ok) die(`\nNo deal: ${out.reason}`);
  finishWith(d, out.terms as any);
}

const commands: Record<string, () => Promise<void>> = { invite, join, accept, serve, negotiate };
if (!cmd || !commands[cmd]) {
  console.error("Usage: relnet <invite|join|accept|serve|negotiate> ...  (see the header of src/cli/relnet.ts)");
  process.exit(64);
}
commands[cmd]().catch((e) => die(`error: ${e instanceof Error ? e.message : e}`));
