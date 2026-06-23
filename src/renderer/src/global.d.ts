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
  DocKind,
  RenderFormat,
  RenderResult,
  CellOutput,
  CellPreviewResult
} from '../../main/quarto'
import type { ManuscriptNote } from '../../main/notes'
import type { RevisingState, FinishResult } from '../../main/revising'
import type { PaperNote } from '../../main/paperNotes'
import type { ConfigFile, ConfigFileInfo, ConfigFileSpec } from '../../main/projectFiles'
import type { ManualRef, ManualRefType } from '../../main/extraRefs'
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
  DocKind,
  RenderFormat,
  RenderResult,
  CellOutput,
  CellPreviewResult,
  ManuscriptNote,
  RevisingState,
  FinishResult,
  PaperNote,
  ConfigFile,
  ConfigFileInfo,
  ConfigFileSpec,
  ManualRef,
  ManualRefType,
  InquirySelection,
  InquiryMeta,
  InquirySummary,
  InquiryDetail,
  CreatedInquiry
}
