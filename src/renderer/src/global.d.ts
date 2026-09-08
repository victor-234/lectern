import type { Api } from '../../preload/index'
import type {
  ResolvedPaper,
  ProjectSummary,
  ProjectPapers,
  Tag,
  Group,
  PaperPatch
} from '../../main/library'
import type { ProjectMeta } from '../../main/scaffold'
import type {
  QuartoDoc,
  RenderFormat,
  RenderResult,
  CellOutput,
  CellPreviewResult
} from '../../main/quarto'
import type { ManuscriptNote } from '../../main/notes'
import type { RevisingState, FinishResult } from '../../main/revising'
import type { PaperNote } from '../../main/paperNotes'
import type { PaperText } from '../../main/paperText'
import type { SemanticHit, SemanticResult } from '../../main/paperSearch'
import type { ConfigFile, ConfigFileInfo, ConfigFileSpec } from '../../main/projectFiles'
import type { ManualRef, ManualRefType } from '../../main/extraRefs'
import type { GitStatus, GitFileChange, GitSyncResult } from '../../main/git'
import type { ApiKeyState } from '../../main/writingRules'
import type { RewriteRequest, RewriteResult } from '../../main/rewrite'
import type { ReviewState, Checkpoint, CheckpointFile } from '../../main/checkpoints'
import type {
  InquirySelection,
  InquiryMeta,
  InquirySummary,
  InquiryDetail,
  CreatedInquiry
} from '../../main/inquiries'

declare global {
  interface Window {
    api: Api
  }
}

export type {
  ResolvedPaper,
  ProjectSummary,
  ProjectPapers,
  Tag,
  Group,
  PaperPatch,
  ProjectMeta,
  QuartoDoc,
  RenderFormat,
  RenderResult,
  CellOutput,
  CellPreviewResult,
  ManuscriptNote,
  RevisingState,
  FinishResult,
  PaperNote,
  PaperText,
  SemanticHit,
  SemanticResult,
  ConfigFile,
  ConfigFileInfo,
  ConfigFileSpec,
  ManualRef,
  ManualRefType,
  GitStatus,
  GitFileChange,
  GitSyncResult,
  ApiKeyState,
  RewriteRequest,
  RewriteResult,
  ReviewState,
  Checkpoint,
  CheckpointFile,
  InquirySelection,
  InquiryMeta,
  InquirySummary,
  InquiryDetail,
  CreatedInquiry
}
