/** Serializable types shared by the parser, repository API, and browser. */
export type ObjectType = "commit" | "tree" | "blob" | "tag";
export type Storage = "loose" | "pack" | "OFS_DELTA" | "REF_DELTA";
export interface Options {
  port?: number;
  host?: string;
  history?: number;
  interval?: number;
}
export interface Field {
  name: string;
  start: number;
  end: number;
  value?: string | number;
}
export interface BytePage {
  offset: number;
  total: number;
  hex: string;
  text: string;
  next: number | null;
}
export interface Content extends BytePage {
  binary: boolean;
  histogram: number[];
  image: string | null;
}
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: "tree" | "gitlink" | "blob";
  start: number;
  end: number;
}
export interface ParsedBody {
  fields: Field[];
  entries?: TreeEntry[];
  headers?: Record<string, string[]>;
  message?: string;
  tree?: string;
  parents?: string[];
  object?: string;
  subject?: string;
}
export interface DeltaInstruction {
  op: "copy" | "insert";
  offset?: number;
  length: number;
  start: number;
  end: number;
  output: number;
}
export interface IndexEntry {
  path: string;
  oid: string;
  mode: string;
  size: number;
  stage: number;
  flags: number;
  extended: number;
  start: number;
  end: number;
}
export interface IndexData {
  entries: IndexEntry[];
  fields: Field[];
  version: number | null;
  count?: number;
  partial?: boolean;
  checksum?: boolean;
  extensions?: { name: string; size: number; start: number; end: number }[];
}
export interface Metadata {
  text: string;
  fields: Field[];
  links: string[];
}
export interface Ref {
  name: string;
  oid: string | null;
  target?: string | null;
  source: string;
}
export interface Commit {
  oid: string;
  tree: string;
  parents: string[];
  subject: string;
  message: string;
  fields: Field[];
  source: string;
  storage: Storage;
}
export interface Tag {
  oid: string;
  name: string;
  object: string;
  subject: string;
  source: string;
  storage: Storage;
}
export interface Operation {
  type: "rebase" | "sequencer";
  directory: string;
  files: Record<string, string>;
}
export interface WorkingFile {
  path: string;
  status: string;
  from?: string | null;
  stages: IndexEntry[];
  oid?: string;
  hidden: boolean;
  size: number;
  preview: Content | null;
  missing: boolean;
}
export interface Mapping {
  old: string;
  oid: string;
  evidence: string;
  exact: boolean;
}
export interface Changes {
  added: string[];
  removed: string[];
  moved: { name: string; from?: string | null; to: string | null }[];
  files: string[];
}
export interface Snapshot {
  id: number;
  time: number;
  root: string;
  name: string;
  algorithm: string;
  refs: Ref[];
  head?: Ref;
  commits: Commit[];
  tags: Tag[];
  files: WorkingFile[];
  fileCount: number;
  index: { version: number | null; count: number; partial?: boolean };
  reflog: { old?: string; oid?: string; actor?: string; message: string }[];
  operation: Operation | null;
  warnings: string[];
  packs: { name: string; count: number }[];
  mappings: Mapping[];
  changes: Changes;
  label: string;
}
export interface Version {
  label: string;
  oid?: string;
  source?: string;
  content?: Content;
  absent?: boolean;
  error?: string;
  symlink?: boolean;
}
export interface FileView {
  path: string;
  hidden?: boolean;
  versions: Version[];
  diff?: string | null;
  staged?: string | null;
  historical?: boolean;
  operation?: Operation | null;
  sides?: { ours?: string | null; theirs?: string | null };
}
