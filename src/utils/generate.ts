/**
	This file has to be CommonJS because importing it from Webpack doesn't work if it's ESM.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'

import * as acorn from 'acorn'
import { camelCase, pascalCase } from 'change-case'
import * as esbuild from 'esbuild'
import { outdent } from 'outdent'
import readdirp from 'readdirp'
import invariant from 'tiny-invariant'

import { type GenerateOptions } from '~/types/options.js'
import { trimExtension } from '~/utils/extension.js'

export class RouteFile {
	filePath: string
	routeGenerator: RouteGenerator

	constructor(options: { filePath: string; routeGenerator: RouteGenerator }) {
		this.filePath = options.filePath
		this.routeGenerator = options.routeGenerator
	}

	get relativeFilePathFromRoutesDir() {
		return path.relative(this.routeGenerator.routesDir, this.filePath)
	}

	async getAst(): Promise<any> {
		const fileContents = await fs.promises.readFile(this.filePath)
		const transpiledFile = await esbuild.transform(fileContents, {
			keepNames: true,
			loader: 'tsx',
		})
		return acorn.parse(transpiledFile.code, {
			ecmaVersion: 2020,
			sourceType: 'module',
		})
	}

	async hasGetServerSidePropsExport() {
		const fileAst = await this.getAst()

		// Check if the route file exports a `getServerSideProps` function
		const exportNamedDeclaration = fileAst.body.find(
			(node: any) => node.type === 'ExportNamedDeclaration'
		)

		const getServerSidePropsExportNamedDeclaration =
			exportNamedDeclaration?.declaration

		if (getServerSidePropsExportNamedDeclaration === undefined) {
			return false
		}

		const hasVariableDeclaration =
			getServerSidePropsExportNamedDeclaration.declarations?.some(
				(declaration: any) => declaration.id?.name === 'getServerSideProps'
			)

		if (hasVariableDeclaration) {
			return true
		}

		const hasFunctionDeclaration =
			getServerSidePropsExportNamedDeclaration.id?.name === 'getServerSideProps'

		if (hasFunctionDeclaration) {
			return true
		}

		const hasExportSpecifier =
			getServerSidePropsExportNamedDeclaration.specifiers?.some(
				(specifier: any) => specifier.exported.name === 'getServerSideProps'
			)

		if (hasExportSpecifier) {
			return true
		}

		return false
	}

	async hasDefaultExport() {
		const fileAst = await this.getAst()

		// Check if the route file exports a `getServerSideProps` function
		return fileAst.body.some(
			(node: any) => node.type === 'ExportDefaultDeclaration'
		)
	}

	getRouteGroups() {
		const routeFilePathSegments = this.relativeFilePathFromRoutesDir.split(
			path.sep
		)

		// A map of file paths to their route groups, which are identified by the path to the route group folder (e.g. `blog/(comments)`)
		const routeGroups: string[] = []

		// We don't iterate over the last `page.tsx` segment because the equivalent in the `/pages` file path segments is omitting it and adding a `.tsx` extension to the second-last path segment.
		for (const [routeSegmentIndex, routeSegment] of routeFilePathSegments
			.slice(0, -1)
			.entries()) {
			// Associate the file with a specific route group
			if (routeSegment.startsWith('(') && routeSegment.endsWith(')')) {
				// Joining up the segments we already visited to create the route group folder path
				const routeGroupFolderPath = routeFilePathSegments
					.slice(0, routeSegmentIndex + 1)
					.join(path.sep)
				routeGroups.push(routeGroupFolderPath)
			}
		}

		return routeGroups
	}

	getTargetPagesFilePath() {
		// Preserve the path of `/pages/api` routes
		if (this.relativeFilePathFromRoutesDir.startsWith('api/')) {
			const pagesFileRelativePath = this.relativeFilePathFromRoutesDir
			return path.join(this.routeGenerator.pagesDir, pagesFileRelativePath)
		}

		const targetPagesFilePathSegments = this.getTargetPagesFilePathSegments()

		// If the path segments are empty, it indicates that the file is the home page `/`
		if (targetPagesFilePathSegments.length === 0) {
			return path.join(this.routeGenerator.pagesDir, 'index.tsx')
		} else {
			targetPagesFilePathSegments[targetPagesFilePathSegments.length - 1] +=
				'.tsx'
			const pagesFileRelativePath = targetPagesFilePathSegments.join(path.sep)
			return path.join(this.routeGenerator.pagesDir, pagesFileRelativePath)
		}
	}

	async writeTargetPagesFile(contents: string) {
		const pagesFilePath = this.getTargetPagesFilePath()
		await fs.promises.mkdir(path.dirname(pagesFilePath), {
			recursive: true,
		})
		await fs.promises.writeFile(pagesFilePath, contents)
	}

	async deleteTargetPagesFile() {
		const pagesFilePath = this.getTargetPagesFilePath()
		await fs.promises.rm(path.dirname(pagesFilePath), {
			force: true,
		})
	}

	public async generateTargetPagesFile() {
		try {
			// `_app.tsx` and `_document.tsx` need to be copied over
			if (['_app', '_document'].includes(path.parse(this.filePath).name)) {
				await fs.promises.mkdir(this.routeGenerator.pagesDir, { recursive: true })
				await fs.promises.cp(
					path.join(this.filePath),
					path.join(
						this.routeGenerator.pagesDir,
						this.relativeFilePathFromRoutesDir
					)
				)
				return
			}

			const ast = await this.getAst()
			const { routesDir } = this.routeGenerator
			// If the page is an api/ page, we just re-export either the default export of the route file
			if (this.relativeFilePathFromRoutesDir.startsWith('api/')) {
				const exportDefaultDeclaration = ast.body.find(
					(node: any) => node.type === 'ExportDefaultDeclaration'
				)

				if (exportDefaultDeclaration !== undefined) {
					// Assume default export
					await this.writeTargetPagesFile(outdent`
						import RouteHandler from '${routesDir}/${trimExtension(
						this.relativeFilePathFromRoutesDir
					)}';
						export default RouteHandler;
					`)
					return
				}
			}
			// If the page is not in api/, only `page.tsx` files can be generated
			else if (trimExtension(path.basename(this.filePath)) !== 'page') {
				return
			}

			const routeGroups = this.getRouteGroups()

			const layoutFilePaths = routeGroups
				.map((routeGroupPath) => {
					for (const extension of ['tsx', 'jsx', 'ts', 'js']) {
						if (
							fs.existsSync(
								path.join(routesDir, routeGroupPath, `layout.${extension}`)
							)
						) {
							return path.join(routesDir, routeGroupPath, `layout.${extension}`)
						}
					}

					return false
				})
				.filter((layoutFilePath) => layoutFilePath !== false) as string[]

			const getLayoutName = (layoutFilePath: string) =>
				pascalCase(
					path.basename(path.dirname(layoutFilePath)).replaceAll(/\W/g, '')
				) + 'Layout'
			const getLayoutGetServerSidePropsExport = (layoutFilePath: string) =>
				`${camelCase(getLayoutName(layoutFilePath))}GetServerSideProps`

			let shouldFileExportGetServerSideProps = false

			const layoutFilePathsWithGetServerSideProps = new Set<string>()
			await Promise.all(
				layoutFilePaths.map(async (layoutFilePath) => {
					const layoutRouteFile = new RouteFile({
						filePath: layoutFilePath,
						routeGenerator: this.routeGenerator,
					})
					if (await layoutRouteFile.hasGetServerSidePropsExport()) {
						layoutFilePathsWithGetServerSideProps.add(layoutFilePath)
					}
				})
			)

			const pagesFileImportLines: string[] = []

			const hasPageComponent = await this.hasDefaultExport()
			if (hasPageComponent) {
				pagesFileImportLines.push(
					"import React from 'react'",
					`import RouteComponent from '${trimExtension(this.filePath)}'`
				)
			}

			const pagesFileTopLevelStatements: string[] = []

			for (const layoutFilePath of layoutFilePaths) {
				if (hasPageComponent) {
					pagesFileImportLines.push(
						`import ${getLayoutName(layoutFilePath)} from '${trimExtension(
							layoutFilePath
						)}'`
					)
				}

				if (layoutFilePathsWithGetServerSideProps.has(layoutFilePath)) {
					shouldFileExportGetServerSideProps = true
					pagesFileImportLines.push(
						`import { getServerSideProps as ${getLayoutGetServerSidePropsExport(
							layoutFilePath
						)} } from '${trimExtension(layoutFilePath)}'`
					)
				}
			}

			if (await this.hasGetServerSidePropsExport()) {
				shouldFileExportGetServerSideProps = true
				pagesFileImportLines.push(
					`import { getServerSideProps as pageGetServerSideProps } from '${trimExtension(
						this.filePath
					)}'`
				)
			}

			if (this.routeGenerator.componentWrapperFunction !== undefined) {
				const { name, path } = this.routeGenerator.componentWrapperFunction
				pagesFileImportLines.push(`import { ${name} } from '${path}'`)
			}

			if (shouldFileExportGetServerSideProps) {
				const getServerSidePropsCalls = [
					...layoutFilePathsWithGetServerSideProps,
				].map(
					(layoutFilePath) =>
						`await ${getLayoutGetServerSidePropsExport(
							layoutFilePath
						)}?.(context) ?? { props: {} }`
				)

				if (await this.hasGetServerSidePropsExport()) {
					getServerSidePropsCalls.push(
						'await pageGetServerSideProps?.(context) ?? { props: {} }'
					)
				}

				let mergedGetServerSidePropsFunction: string
				if (getServerSidePropsCalls.length === 1) {
					mergedGetServerSidePropsFunction = outdent`
						async (context) => {
							return ${getServerSidePropsCalls[0]};
						}
					`
				} else {
					pagesFileImportLines.push(
						"import { deepmerge } from 'next-routes-dir/deepmerge'"
					)
					mergedGetServerSidePropsFunction = outdent`
						async (context) => {
							return deepmerge(
								${getServerSidePropsCalls.join(',\n\t\t')}
							)
						}
					`
				}

				if (
					this.routeGenerator.getServerSidePropsWrapperFunction === undefined
				) {
					pagesFileTopLevelStatements.push(
						`export const getServerSideProps = ${mergedGetServerSidePropsFunction}`
					)
				} else {
					const { name, path } =
						this.routeGenerator.getServerSidePropsWrapperFunction
					pagesFileImportLines.push(`import { ${name} } from '${path}'`)
					pagesFileTopLevelStatements.push(
						`export const getServerSideProps = ${name}(${mergedGetServerSidePropsFunction})`
					)
				}
			}

			if (hasPageComponent) {
				const getComponentJsxString = (layoutFilePaths: string[]): string => {
					if (layoutFilePaths.length === 0) {
						return '<RouteComponent {...props} />'
					} else {
						invariant(layoutFilePaths[0], 'remainingLayoutPaths is not empty')
						const layoutName = getLayoutName(layoutFilePaths[0])
						return outdent`
							<${layoutName} {...props}>${getComponentJsxString(
							layoutFilePaths.slice(1)
						)}</${layoutName}>
						`
					}
				}

				if (this.routeGenerator.componentWrapperFunction === undefined) {
					pagesFileTopLevelStatements.push(
						`export default (props) => (${getComponentJsxString(
							layoutFilePaths
						)})`
					)
				} else {
					pagesFileTopLevelStatements.push(
						`export default ${this.routeGenerator.componentWrapperFunction.name
						}((props) => (${getComponentJsxString(layoutFilePaths)}))`
					)
				}
			}

			const pagesFileContents = outdent`
				${pagesFileImportLines.join(';\n')}

				${pagesFileTopLevelStatements.join(';\n')}
			`

			await this.writeTargetPagesFile(pagesFileContents)
		} catch (error: unknown) {
			console.error(
				`Received error while creating a generated TypeScript file for file \`${this.relativeFilePathFromRoutesDir}\`:`,
				error
			)
		}
	}

	getTargetPagesFilePathSegments() {
		const routeFilePathSegments = this.relativeFilePathFromRoutesDir.split(
			path.sep
		)
		const pagesFilePathSegments: string[] = []

		for (const routeSegment of routeFilePathSegments.slice(0, -1)) {
			if (!(routeSegment.startsWith('(') && routeSegment.endsWith(')'))) {
				pagesFilePathSegments.push(routeSegment)
			}
		}

		return pagesFilePathSegments
	}
}

export class RouteGenerator {
	pagesDir: string
	routesDir: string
	componentWrapperFunction?: { path: string; name: string }
	getServerSidePropsWrapperFunction?: { path: string; name: string }

	constructor(options: GenerateOptions) {
		this.pagesDir = options.pagesDir
		this.routesDir = options.routesDir
		this.componentWrapperFunction = options.componentWrapperFunction
		this.getServerSidePropsWrapperFunction =
			options.getServerSidePropsWrapperFunction
	}

	/**
		Generates a `/pages` directory based on the `/routes` directory (a manual alternative to
		the `/app` directory introduced in Next.js 13 that has some performance problems while in beta)
	*/
	async generatePagesDirectory() {
		try {
			const routeFilePathsData = await readdirp.promise(this.routesDir, {
				type: 'files',
			})

			// Create a map of all the route pages
			const routeFileToPagesFile = new Map<string, string>()
			const routeFiles: RouteFile[] = []
			for (const { fullPath: routeFilePath } of routeFilePathsData) {
				const routeFile = new RouteFile({
					filePath: routeFilePath,
					routeGenerator: this,
				})
				routeFileToPagesFile.set(
					routeFilePath,
					routeFile.getTargetPagesFilePath()
				)
				routeFiles.push(routeFile)
			}

			// If the `pages/` directory already exists, iterate through it and delete any files which don't have a corresponding `routes/` file
			if (fs.existsSync(this.pagesDir)) {
				/**
				A map of the relative `pages/` file path (e.g. `blog/slug.tsx`) to the corresponding relative `routes/` file path (e.g. `blog/[slug]/page.tsx`)

				The inverse of `routeFileToPagesFile`
			*/
				const pagesFileToRouteFile = new Map(
					[...routeFileToPagesFile.entries()].map(([key, value]) => [
						value,
						key,
					])
				)
				const generatedPagesFiles = await readdirp.promise(this.pagesDir, {
					type: 'files',
				})

				await Promise.all(
					generatedPagesFiles.map(async (generatedPagesFile) => {
						const generatedPagesFileRelativePath = path.relative(
							this.pagesDir,
							generatedPagesFile.fullPath
						)
						if (!pagesFileToRouteFile.has(generatedPagesFileRelativePath)) {
							await fs.promises.rm(generatedPagesFile.fullPath)
						}
					})
				)
			}

			// Generate the `pages/` files for each `routes/` file
			await Promise.all(
				routeFiles.map(async (routeFile) => routeFile.generateTargetPagesFile())
			)
		} catch (error) {
			console.error('Error while generating pages directory:', error)
		}
	}
}
