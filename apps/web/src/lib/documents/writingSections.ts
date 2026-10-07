import { z } from "zod";
import type { WritingComposition } from "./writingComposition";
import type { WritingConsistencyReport } from "./writingConsistency";

const sectionIdentity = { fieldId: z.string().uuid(), expectedRevision: z.number().int().min(0) };
export const saveWritingSectionSchema = z.object({ ...sectionIdentity,
  text: z.string().max(12000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
}).strict();
export const generateWritingSectionSchema = z.object({ ...sectionIdentity, requestId: z.string().uuid() }).strict();
export interface WritingSectionProposal {
  id: string;
  baseRevision: number;
  status: "running" | "ready" | "failed";
  composition: WritingComposition | null;
  stale: boolean;
  message: string | null;
}
export interface WritingSection {
  fieldId: string;
  label: string;
  guidance: string | null;
  available: boolean;
  revision: number;
  text: string;
  proposal: WritingSectionProposal | null;
}
export interface WritingSections { sections: WritingSection[]; canWrite: boolean; canGenerate: boolean; consistency: WritingConsistencyReport | null }
