import { readFileSync } from "node:fs";
import { Mandate } from "../agents/negotiate.js";
import { parseMandate } from "../examples/companies.js";

/** Reads a mandate.json (the shape used under examples/companies). The file also names the side it is for. */
export function loadCompanyFile(file: string): { side: "buyer" | "supplier"; mandate: Mandate } {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.side !== "buyer" && j.side !== "supplier") throw new Error(`${file}: "side" must be buyer or supplier`);
  return { side: j.side, mandate: parseMandate(j) };
}
