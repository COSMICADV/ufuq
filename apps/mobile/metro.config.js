/**
 * Metro in a pnpm workspace.
 *
 * pnpm does not hoist, so Metro needs two things it cannot infer: the workspace
 * root, so it watches the packages the app depends on, and the workspace
 * `node_modules`, so it can resolve them. Hierarchical lookup stays on — it is
 * how Metro reaches each package's own dependencies inside the pnpm store.
 */
const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
