// Each agent signs the final settlement record with its wallet key so either side
// (or a judge) can verify who agreed to what, off-chain.

import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";

export async function signRecord(privKey, record) {
  const account = privateKeyToAccount(privKey);
  const message = JSON.stringify(record);
  const signature = await account.signMessage({ message });
  return { record, signer: account.address, signature };
}

export async function verifyRecord({ record, signer, signature }) {
  return verifyMessage({ address: signer, message: JSON.stringify(record), signature });
}
