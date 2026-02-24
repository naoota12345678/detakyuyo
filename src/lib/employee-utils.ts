/**
 * 退社系ステータスかどうかを判定する
 * "退社" および "退社（非表示）" を退社扱いとする
 */
export function isRetired(status: string | undefined): boolean {
  return status === "退社" || status === "退社（非表示）";
}
