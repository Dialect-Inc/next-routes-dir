/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

/**
	This file has to be CommonJS because importing it from Webpack doesn't work if it's ESM.
*/
import * as fs from 'node:fs'
import * as path from 'node:path'

import * as acorn from 'acorn'
import { pascalCase, camelCase } from 'change-case'
import * as esbuild from 'esbuild'
import { outdent } from 'outdent'
import readdirp from 'readdirp'
import invariant from 'tiny-invariant'

import { type GenerateOptions } from '~/types/options.js'
import { trimExtension } from '~/utils/extension.js'

export class RouteFile {
	filePath: string
	routeGenerator: RouteGenerator

	constructor(options: { filePath: string, routeGenerator: RouteGenerator }) {
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
			exportNamedDeclaration?.declaration?.declarations?.find(
				(declaration: any) =>
					declaration.id?.name === 'getServerSideProps'
			)

		return getServerSidePropsExportNamedDeclaration !== undefined
	}

	getRouteGroups() {
		const routeFilePathSegments = this.relativeFilePathFromRoutesDir.split(path.sep)

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
			return pagesFileRelativePath
		}

		const targetPagesFilePathSegments = this.getTargetPagesFilePathSegments()

		// If the path segments are empty, it indicates that the file is the home page `/`
		if (targetPagesFilePathSegments.length === 0) {
			return 'index.tsx'
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

	async generateTargetPagesFile() {
		const fileName = path.basename(this.filePath)

		// `_app.tsx` and `_document.tsx` need to be copied over
		if (['_app', '_document'].includes(path.parse(fileName).name)) {
			await fs.promises.cp(
				path.join(this.routeGenerator.pagesDir, fileName),
				path.join(this.routeGenerator.routesDir, fileName)
			)
			return
		}

		// Otherwise, only `page.tsx` files can be generated
		if (trimExtension(path.basename(this.filePath)) !== 'page') {
			return
		}

		const ast = await this.getAst()
		const { routesDir } = this.routeGenerator

		try {
			// If the page is an api/ page, we just re-export either the default export of the route file or the first named export of the route file as the default export
			if (this.relativeFilePathFromRoutesDir.startsWith('api/')) {
				const exportNamedDeclaration = ast.body.find(
					(node: any) => node.type === 'ExportNamedDeclaration'
				)

				const variableName =
					exportNamedDeclaration?.declaration?.declarations?.[0]?.id?.name

				const exportDefaultDeclaration = ast.body.find(
					(node: any) => node.type === 'ExportDefaultDeclaration'
				)

				if (
					exportDefaultDeclaration !== undefined ||
					variableName === undefined
				) {
					// Assume default export
					await this.writeTargetPagesFile(outdent`
						import RouteHandler from '${routesDir}/${trimExtension(this.relativeFilePathFromRoutesDir)}';
						export default RouteHandler;
					`)
					return
				}

				await this.writeTargetPagesFile(outdent`
					import { ${variableName} } from '${routesDir}/${trimExtension(this.relativeFilePathFromRoutesDir)}';
					export default ${variableName};
				`)
				return
			}

			const routeGroups = this.getRouteGroups()

			const layoutPaths = routeGroups.filter(
				(routeGroupPath) =>
					fs.existsSync(path.join(routesDir, routeGroupPath, 'layout.tsx')) ||
					fs.existsSync(path.join(routesDir, routeGroupPath, 'layout.jsx')) ||
					fs.existsSync(path.join(routesDir, routeGroupPath, 'layout.ts')) ||
					fs.existsSync(path.join(routesDir, routeGroupPath, 'layout.js'))
			)

			const getLayoutName = (layoutPath: string) =>
				pascalCase(layoutPath.replaceAll(/\W/g, '')) + 'Layout'
			const getLayoutGetServerSidePropsExport = (layoutPath: string) =>
				`${camelCase(getLayoutName(layoutPath))}GetServerSideProps`

			let shouldFileExportGetServerSideProps = false

			const layoutImports = (await Promise.all(layoutPaths.map(
				async (layoutPath) => {
					let layoutImport = outdent({ trimTrailingNewline: false })`
						import ${getLayoutName(layoutPath)} from '${routesDir}/${layoutPath}/layout'
					`

					if (await this.hasGetServerSidePropsExport()) {
						shouldFileExportGetServerSideProps = true
						layoutImport += outdent({ trimTrailingNewline: false })`
						import { getServerSideProps as ${getLayoutGetServerSidePropsExport(layoutPath)} } from '${routesDir}/${layoutPath}/layout'
					`
					}

					return layoutImport
				}
			))).join('\n')

			const getComponentJsxString = (
				remainingLayoutPaths: string[]
			): string => {
				if (remainingLayoutPaths.length === 0) {
					return `<RouteComponent {...props} />`
				} else {
					invariant(
						remainingLayoutPaths[0],
						'remainingLayoutPaths is not empty'
					)
					const layoutName = getLayoutName(remainingLayoutPaths[0])
					return outdent`
					<${layoutName} {...props}>${getComponentJsxString(remainingLayoutPaths.slice(1))}</${layoutName}>
				`
				}
			}

			let pagesFileContents = outdent({ trimTrailingNewline: false })`
				import React from 'react';
				import { deepmerge } from 'next-routes-dir/deepmerge';
				${layoutImports}
				import RouteComponent from '${trimExtension(this.filePath)}';
			`

			if (await this.hasGetServerSidePropsExport()) {
				shouldFileExportGetServerSideProps = true
				pagesFileContents += outdent({ trimTrailingNewline: false })`
					import { getServerSideProps as pageGetServerSideProps } from '${trimExtension(
					this.filePath
				)}'
				`
			}

			if (this.routeGenerator.componentWrapperFunction !== undefined) {
				const { name, path } = this.routeGenerator.componentWrapperFunction
				pagesFileContents += outdent({ trimTrailingNewline: false })`
					import { ${name} } from '${path}';
				`
			}

			if (shouldFileExportGetServerSideProps) {
				const layoutGetServerSidePropsCalls = layoutPaths.map(
					(layoutPath) =>
						`await ${getLayoutGetServerSidePropsExport(
							layoutPath
						)}?.(context) ?? { props: {} }`
				).join(',\n\t\t')

				let mergedGetServerSidePropsFunction: string
				if (layoutPaths.length > 0) {
					mergedGetServerSidePropsFunction = outdent`
					async (context) => {
						return deepmerge(
							${layoutGetServerSidePropsCalls},
							await pageGetServerSideProps?.(context) ?? { props: {} }
						)
					}
				`
				} else {
					mergedGetServerSidePropsFunction = outdent`
						async (context) => {
							return pageGetServerSideProps?.(context) ?? { props: {} }
						}
					`
				}

				if (this.routeGenerator.getServerSidePropsWrapperFunction === undefined) {
					pagesFileContents += outdent({ trimTrailingNewline: false })`
						export const getServerSideProps = ${mergedGetServerSidePropsFunction};
					`
				} else {
					const { name, path } = this.routeGenerator.getServerSidePropsWrapperFunction
					pagesFileContents += outdent({ trimTrailingNewline: false })`
					import { ${name} } from '${path}';
					export const getServerSideProps = ${name}(${mergedGetServerSidePropsFunction});
				`
				}
			}

			if (this.routeGenerator.componentWrapperFunction === undefined) {
				pagesFileContents += outdent`
					export default (props) => (${getComponentJsxString(layoutPaths)});
				`
			} else {
				pagesFileContents += outdent`
					export default ${this.routeGenerator.componentWrapperFunction.name}((props) => (
						${getComponentJsxString(layoutPaths)}
					));
				`
			}

			this.writeTargetPagesFile(pagesFileContents)
		} catch (error: unknown) {
			console.error(
				`Received error while creating a generated TypeScript file for file \`${this.relativeFilePathFromRoutesDir}\`:`,
				error
			)
		}
	}

	getTargetPagesFilePathSegments() {
		const routeFilePathSegments = this.relativeFilePathFromRoutesDir.split(path.sep)
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
		this.getServerSidePropsWrapperFunction = options.getServerSidePropsWrapperFunction
	}

	/**
		Generates a `/pages` directory based on the `/routes` directory (a manual alternative to
		the `/app` directory introduced in Next.js 13 that has some performance problems while in beta)
	*/
	async generatePagesDirectory() {
		const routeFilePathsData = await readdirp.promise(this.routesDir, { type: 'files' })

		// Create a map of all the route pages
		const routeFileToPagesFile = new Map<string, string>()
		const routeFiles: RouteFile[] = []
		for (const { fullPath: routeFilePath } of routeFilePathsData) {
			const routeFile = new RouteFile({ filePath: routeFilePath, routeGenerator: this })
			routeFileToPagesFile.set(routeFilePath, routeFile.getTargetPagesFilePath())
			routeFiles.push(routeFile)
		}

		// If the `pages/` directory already exists, iterate through it and delete any files which don't have a corresponding `routes/` file
		if (fs.existsSync(this.pagesDir)) {
			/**
				A map of the relative `pages/` file path (e.g. `blog/slug.tsx`) to the corresponding relative `routes/` file path (e.g. `blog/[slug]/page.tsx`)

				The inverse of `routeFileToPagesFile`
			*/
			const pagesFileToRouteFile = new Map(
				[...routeFileToPagesFile.entries()].map(([key, value]) => [value, key])
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

		// Generate the `pages/` files
		await Promise.all(routeFiles.map(async routeFile => routeFile.generateTargetPagesFile()))

		// The `_app.tsx` and `_document.tsx` files can't be imported and need to be copied because they are special files in Next.js and can do stuff like importing global CSS
		for (const fileBasename of ['_document', '_app']) {
			for (const extension of ['tsx', 'jsx', 'ts', 'js']) {
				const fileName = `${fileBasename}.${extension}`
				if (fs.existsSync(path.join(this.routesDir, fileName))) {
					await fs.promises.cp(
						path.join(this.pagesDir, fileName),
						path.join(this.routesDir, fileName)
					)
					break
				}
			}
		}
	}
}
