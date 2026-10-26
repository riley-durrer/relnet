import { createPXEClient, waitForPXE } from "@aztec/aztec.js";

const PXE_URL = process.env.PXE_URL ?? "http://localhost:8080";

export async function setupPXE() {
  const pxe = createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  return pxe;
}
