export type BespokeAuthGate = "public" | "authenticated" | "self";

export type BespokeFieldType =
  | "string"
  | "string[]"
  | "url"
  | "image[]"
  | "boolean"
  | "json";

export interface BespokeFieldManifest {
  id: string;
  label: string;
  type: BespokeFieldType;
  dataPath: string;
  editable: boolean;
  hideable?: boolean;
  description?: string;
}

export interface BespokeMutationField {
  id: string;
  label: string;
  type: BespokeFieldType;
  required?: boolean;
  description?: string;
}

export interface BespokeMutationManifest {
  id: string;
  label: string;
  description?: string;
  auth: BespokeAuthGate;
  importPath: string;
  exportName: string;
  kind: "server-action";
  fields: BespokeMutationField[];
}

export interface BespokeComponentManifest {
  id: string;
  label: string;
  importPath: string;
  exportName: string;
  description?: string;
}

export interface BespokeSectionManifest {
  id: string;
  label: string;
  dataPath: string;
  defaultComponentId: string;
  description?: string;
  hideable?: boolean;
  themeable?: boolean;
}

export interface BespokeThemeManifest {
  mode: "tokens";
  editableTokens: string[];
  presets: string[];
}

export interface BespokeModuleManifest {
  moduleId: string;
  version: string;
  title: string;
  auth: BespokeAuthGate;
  dataEndpoint: string;
  manifestEndpoint: string;
  description?: string;
  fields: BespokeFieldManifest[];
  mutations: BespokeMutationManifest[];
  components: BespokeComponentManifest[];
  sections: BespokeSectionManifest[];
  theme: BespokeThemeManifest;
}

export interface MyProfileModuleBundle {
  success: boolean;
  actorId: string;
  profile: unknown;
  savedListingIds: string[];
  wallet: unknown;
  wallets: unknown;
  transactions: unknown;
  ticketPurchases: unknown;
  subscriptions: unknown;
  receipts: unknown;
  posts: unknown;
  events: unknown;
  groups: unknown;
  marketplaceListings: unknown;
  reactionCounts: unknown;
  connections: unknown;
  module: {
    moduleId: string;
    manifestEndpoint: string;
  };
  federation: {
    localInstanceId: string;
    localInstanceType: string;
    localInstanceSlug: string;
    homeInstance: unknown;
    isHomeInstance: boolean;
  };
}

export interface PublicProfileModuleBundle {
  success: boolean;
  actorId: string | null;
  subjectId: string;
  subjectUsername: string;
  agent: unknown;
  profile: unknown;
  posts: unknown;
  events: unknown;
  groups: unknown;
  module: {
    moduleId: string;
    manifestEndpoint: string;
  };
  federation: {
    localInstanceId: string;
    localInstanceType: string;
    localInstanceSlug: string;
    homeInstance: unknown;
    isHomeInstance: boolean;
  };
}
