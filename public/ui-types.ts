import type { ApiResponses } from "./api.js";
export type UiElement = HTMLElement & { dragged?: boolean };
export interface Point {
  x: number;
  y: number;
}
export interface Position extends Point {
  manual: boolean;
}
export interface Edge {
  from: string;
  to: string;
  selected?: boolean;
  tag?: boolean;
  mapping?: boolean;
  exact?: boolean;
}
interface Steps {
  step: number;
  maxStep: number;
}
export type Inspector =
  | { kind: "custom"; html: string }
  | ({
      kind: "object";
      object: ApiResponses["object"];
      offset: number;
      part: string;
    } & Steps)
  | ({
      kind: "meta";
      data: ApiResponses["meta"];
      isWork?: boolean;
      fileData?: ApiResponses["file"];
      reveal?: boolean;
    } & Steps)
  | {
      kind: "file";
      data: ApiResponses["file"];
      offset: number;
      reveal: boolean;
    };
