import { type FacetBundleArtifact } from "@earendil-works/chord/node";
import type { ServerId } from "@earendil-works/pi-protocol";
export interface ConfiguredServerPluginPackage {
    readonly manifestPath: string;
    build(): Promise<readonly FacetBundleArtifact[]>;
}
/** Persist an explicit plugin package selection or restore it for a later server generation. */
export declare function restoreServerPluginPackageProfile(directory: string, serverId: ServerId, configuredPackagePaths?: readonly string[]): Promise<readonly string[]>;
/** Read the explicit plugin selection stored for one durable Session. */
export declare function readSessionPluginPackageProfile(directory: string, serverId: ServerId, sessionPath: string): Promise<readonly string[] | undefined>;
/** Remove the plugin selection stored for one deleted Session. */
export declare function removeSessionPluginPackageProfile(directory: string, serverId: ServerId, sessionPath: string): Promise<void>;
/** Persist the plugin selection for one durable Session. */
export declare function writeSessionPluginPackageProfile(directory: string, serverId: ServerId, sessionPath: string, packagePaths: readonly string[]): Promise<void>;
/** Create a serialized server-owned builder for one configured plugin package. */
export declare function createServerPluginPackage(directory: string, serverId: ServerId, packagePath: string): ConfiguredServerPluginPackage;
export declare function normalizePluginPackagePaths(packagePaths: readonly string[]): readonly string[];
//# sourceMappingURL=package.d.ts.map