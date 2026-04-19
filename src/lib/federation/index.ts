export { getInstanceConfig, isGlobalInstance, getGlobalInstanceId, resetInstanceConfig } from './instance-config';
export type { InstanceConfig, InstanceType } from './instance-config';
export { resolveHomeInstance, listInstances } from './resolution';
export type { HomeInstanceInfo } from './resolution';
export { emitDomainEvent, EVENT_TYPES } from './domain-events';
export type { DomainEvent, EventType } from './domain-events';
export { UpdateFacade, updateFacade } from './update-facade';
export type { Mutation, MutationResult } from './update-facade';
export { routeWrite, resolveWriteTarget } from './write-router';
export type { RoutedWrite, RoutingProvenance, WriteRouterResult } from './write-router';
export { federatedWrite, isLocalWrite } from './remote-write';
export type { FederatedWriteParams, FederatedWriteResult } from './remote-write';
export { QueryFacade, queryFacade } from './query-facade';
export type { QueryResult, DataSource } from './query-facade';
export { getProfileUrl, buildProfileUrl } from './profile-link';
export { getGlobalBaseUrl, getGlobalUrl } from './global-url';
export { callRemoteMcpTool, listRemoteMcpTools, RemoteMcpClient, RemoteMcpError } from './remote-mcp-client';
export type {
  RemoteMcpCallParams,
  RemoteMcpCallResult,
  RemoteMcpListParams,
  RemoteMcpListResult,
  RemoteMcpToolDefinition,
  RemoteMcpClientOptions,
} from './remote-mcp-client';
export type {
  HomeAuthorityRef,
  FederatedActorContext,
  CanonicalProfileRef,
  ProjectedDatapoint,
  ProjectionPointer,
  ManifestRef,
  FederationFacadeResponse,
  UniversalManifestProjection,
  RemoteViewerState,
  RemoteAuthResult,
  FederatedInteractionRequest,
  FederatedInteractionAction,
  FederatedInteractionResult,
} from './cross-instance-types';
