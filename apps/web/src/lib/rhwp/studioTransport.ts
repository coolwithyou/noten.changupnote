import type { RhwpWorkingDocumentTransport } from "./workingDocument";

export type StudioSnapshotCommit<T> =
  | { mode: "local_preview" }
  | { mode: "persistent"; value: T };

/**
 * Studio 스냅샷의 영속 경계.
 *
 * local_preview에서는 persist 콜백 자체를 호출하지 않는다. UI의 분기나 호출자 관례에 기대지 않고
 * 이 함수 하나가 draft/snapshot write 가능 여부를 결정한다.
 */
export async function commitStudioSnapshot<T>(input: {
  transport: RhwpWorkingDocumentTransport;
  persist: (draftId: string) => Promise<T>;
}): Promise<StudioSnapshotCommit<T>> {
  if (input.transport.mode === "local_preview") return { mode: "local_preview" };
  return {
    mode: "persistent",
    value: await input.persist(input.transport.draftId),
  };
}
