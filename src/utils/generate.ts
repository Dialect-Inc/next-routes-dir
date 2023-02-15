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
import pMemoize from 'p-memoize'
import readdirp from 'readdirp'
import invariant from 'tiny-invariant'

import { type GenerateOptions } from '~/types/options.js'

const getFileAst = pMemoize(async (filePath: string): Promise<any> => {
	const fileContents = await fs.promises.readFile(filePath)
	const transpiledFile = await esbuild.transform(fileContents, {
		keepNames: true,
		loader: 'tsx',
	})
	return acorn.parse(transpiledFile.code, {
		ecmaVersion: 2020,
		sourceType: 'module',
	})
})

/**
	Generates a `/pages` directory based on the `/routes` directory (a manual alternative to
	the `/app` directory introduced in Next.js 13 that has some performance problems while in beta)
*/
export async function generatePagesFromRoutes({
	pagesDir: generatedPagesDir,
	routesDir,
	componentWrapperFunction,
	getServerSidePropsWrapperFunction
}: GenerateOptions) {
	const trimExtension = (filePath: string) => filePath.replace(/\.[^/.]+$/, '')

	/**
		A map of the relative `routes/` file path (e.g. `blog/[slug]/page.tsx`) to the corresponding relative `pages/` file path (e.g. `blog/slug.tsx`)
	*/
	const routeFileToPagesFile = new Map<string, string>()

	// A map of file paths to their route groups, which are identified by the path to the route group folder (e.g. `blog/(comments)`)
	const routeGroupMap = new Map<string, string[]>()

	const addRouteGroup = (
		routeFilePath: string,
		routeGroupFolderPath: string
	) => {
		let routeGroups = routeGroupMap.get(routeFilePath)
		if (routeGroups === undefined) {
			routeGroups = []
			routeGroupMap.set(routeFilePath, routeGroups)
		}

		routeGroups.push(routeGroupFolderPath)
	}

	// We iterate over every file in the `/routes` directory and map them to their new file location in the `/pages` directory
	const routeFiles = await readdirp.promise(routesDir, { type: 'files' })
	for (const routeFile of routeFiles) {
		const routeFileFullPath = routeFile.fullPath
		const routeFileRelativePath = path.relative(routesDir, routeFileFullPath)

		// Preserve the path of `/pages/api` routes
		if (routeFileRelativePath.startsWith('api/')) {
			const pagesFileRelativePath = routeFileRelativePath
			routeFileToPagesFile.set(routeFileRelativePath, pagesFileRelativePath)
			continue
		}

		const routeFilePathSegments = routeFileRelativePath.split(path.sep)
		const lastPathSegment = routeFilePathSegments.at(-1)
		invariant(lastPathSegment, 'lastPathSegment is not undefined')

		switch (trimExtension(lastPathSegment)) {
			case 'page': {
				const pagesDirFilePathSegments: string[] = []

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
						addRouteGroup(routeFileRelativePath, routeGroupFolderPath)

						// Don't continue adding a segment to the `/pages` file path segments because it doesn't support route grouping
						continue
					} else {
						pagesDirFilePathSegments.push(routeSegment)
					}
				}

				// If the path segments are empty, it indicates that the file is the home page `/`
				if (pagesDirFilePathSegments.length === 0) {
					const pagesFileRelativePath = 'index.tsx'
					routeFileToPagesFile.set(routeFileRelativePath, pagesFileRelativePath)
				} else {
					pagesDirFilePathSegments[pagesDirFilePathSegments.length - 1] +=
						'.tsx'
					const pagesFileRelativePath = pagesDirFilePathSegments.join(path.sep)
					routeFileToPagesFile.set(routeFileRelativePath, pagesFileRelativePath)
				}

				break
			}

			case 'layout': {
				break
			}
			// TODO

			default: {
				break
			}
			// Do nothing and assume that the file is a component file for the purpose of co-location
		}
	}

	// If the `pages/` directory already exists, iterate through it and delete any files which don't have a corresponding `routes/` file
	if (fs.existsSync(generatedPagesDir)) {
		/**
			A map of the relative `pages/` file path (e.g. `blog/slug.tsx`) to the corresponding relative `routes/` file path (e.g. `blog/[slug]/page.tsx`)

			The inverse of `routeFileToPagesFile`
		*/
		const pagesFileToRouteFile = new Map(
			[...routeFileToPagesFile.entries()].map(([key, value]) => [value, key])
		)
		const generatedPagesFiles = await readdirp.promise(generatedPagesDir, {
			type: 'files',
		})

		await Promise.all(
			generatedPagesFiles.map(async (generatedPagesFile) => {
				const generatedPagesFileRelativePath = path.relative(
					generatedPagesDir,
					generatedPagesFile.fullPath
				)
				if (!pagesFileToRouteFile.has(generatedPagesFileRelativePath)) {
					await fs.promises.rm(generatedPagesFile.fullPath)
				}
			})
		)
	}

	// Iterate through all the route path mappings to create the generated TypeScript files
	await Promise.all(
		[...routeFileToPagesFile.entries()].map(
			async ([routeFileRelativePath, pagesFileRelativePath]) => {
				const routeFileFullPath = path.join(routesDir, routeFileRelativePath)
				const routeFileAst = await getFileAst(routeFileFullPath)
				try {
					if (routeFileRelativePath.startsWith('api/')) {
						const writePagesFile = async (contents: string) => {
							const pagesFileFullPath = path.join(
								generatedPagesDir,
								pagesFileRelativePath
							)
							await fs.promises.mkdir(path.dirname(pagesFileFullPath), {
								recursive: true,
							})
							await fs.promises.writeFile(pagesFileFullPath, contents)
						}

						const exportNamedDeclaration = routeFileAst.body.find(
							(node: any) => node.type === 'ExportNamedDeclaration'
						)

						const variableName =
							exportNamedDeclaration?.declaration?.declarations?.[0]?.id?.name

						const exportDefaultDeclaration = routeFileAst.body.find(
							(node: any) => node.type === 'ExportDefaultDeclaration'
						)

						if (
							exportDefaultDeclaration !== undefined ||
							variableName === undefined
						) {
							// Assume default export
							await writePagesFile(outdent`
								import Route from '${routesDir}/${trimExtension(routeFileRelativePath)}';
								export default Route;
							`)
							return
						}

						await writePagesFile(outdent`
							import { ${variableName} } from '${routesDir}/${trimExtension(
							routeFileRelativePath
						)}';
							export default ${variableName};
						`)
						return
					}

					const potentialLayoutPaths =
						routeGroupMap.get(routeFileRelativePath) ?? []
					const layoutPaths = potentialLayoutPaths.filter(
						(layoutPath) =>
							fs.existsSync(path.join(routesDir, layoutPath, 'layout.tsx')) ||
							fs.existsSync(path.join(routesDir, layoutPath, 'layout.jsx'))
					)

					const getLayoutName = (layoutPath: string) =>
						pascalCase(layoutPath.replaceAll(/\W/g, '')) + 'Layout'
					const getLayoutGetServerSidePropsExport = (layoutPath: string) =>
						`${camelCase(getLayoutName(layoutPath))}GetServerSideProps`

					const layoutImports = layoutPaths
						.map(
							(layoutPath) =>
								outdent`
									import ${getLayoutName(
									layoutPath
								)}, { getServerSideProps as ${getLayoutGetServerSidePropsExport(
									layoutPath
								)} } from '${routesDir}/${layoutPath}/layout';
								`
						)
						.join('\n')

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
								<${layoutName} {...props}>${getComponentJsxString(
								remainingLayoutPaths.slice(1)
							)}</${layoutName}>
							`
						}
					}

					let pagesFileContents = outdent({ trimTrailingNewline: false })`
						import React from 'react';
						import { deepmerge } from 'next-routes-dir/deepmerge';
						${layoutImports}
						import RouteComponent, { getServerSideProps as pageGetServerSideProps } from '${trimExtension(
						routeFileFullPath
					)}';
					`

					if (componentWrapperFunction !== undefined) {
						pagesFileContents += outdent({ trimTrailingNewline: false })`
							import { ${componentWrapperFunction.name} } from '${componentWrapperFunction.path}';
						`
					}

					const condition = [
						'pageGetServerSideProps === undefined',
						...layoutPaths
							.map(
								(layoutPath) =>
									`${getLayoutGetServerSidePropsExport(layoutPath)} === undefined`
							)
					].join(' && ')

					const mergedGetServerSidePropsFunction = outdent`
						async (context) => {
							return deepmerge(
								await pageGetServerSideProps?.(context) ?? { props: {} },
								${
									layoutPaths.map(
										(layoutPath) =>
											`await ${getLayoutGetServerSidePropsExport(
												layoutPath
											)}?.(context) ?? { props: {} }`
									).join(',\n\t\t')
								}
							)
						}
					`

					if (getServerSidePropsWrapperFunction === undefined) {
						pagesFileContents += outdent({ trimTrailingNewline: false })`
							export const getServerSideProps = ${condition} ? undefined : ${mergedGetServerSidePropsFunction};
						`
					} else {
						pagesFileContents += outdent({ trimTrailingNewline: false })`
							export const getServerSideProps = ${condition} ? undefined : ${getServerSidePropsWrapperFunction.name}(${mergedGetServerSidePropsFunction});
						`
					}

					if (componentWrapperFunction === undefined) {
						pagesFileContents += outdent`
							export default (props) => (${getComponentJsxString(layoutPaths)});
						`
					} else {
						pagesFileContents += outdent`
							export default ${componentWrapperFunction.name}((props) => (
								${getComponentJsxString(layoutPaths)}
							));
						`
					}

					const pagesFileFullPath = path.join(
						generatedPagesDir,
						pagesFileRelativePath
					)
					await fs.promises.mkdir(path.dirname(pagesFileFullPath), {
						recursive: true,
					})
					await fs.promises.writeFile(pagesFileFullPath, pagesFileContents)
				} catch (error: unknown) {
					console.error(
						`Received error while creating a generated TypeScript file for file \`${routeFileRelativePath}\`:`,
						error
					)
				}
			}
		)
	)

	// Copy over `_app.tsx` and `_document.tsx`
	// These files can't be imported but need to be copied because they are special files in Next.js and can do stuff like importing global CSS
	if (fs.existsSync(path.join(routesDir, '_app.tsx'))) {
		await fs.promises.writeFile(
			path.join(generatedPagesDir, '_app.tsx'),
			await fs.promises.readFile(path.join(routesDir, '_app.tsx'))
		)
	} else if (fs.existsSync(path.join(routesDir, '_app.jsx'))) {
		await fs.promises.writeFile(
			path.join(generatedPagesDir, '_app.jsx'),
			await fs.promises.readFile(path.join(routesDir, '_app.jsx'))
		)
	}

	if (fs.existsSync(path.join(routesDir, '_document.tsx'))) {
		await fs.promises.writeFile(
			path.join(generatedPagesDir, '_document.tsx'),
			await fs.promises.readFile(path.join(routesDir, '_document.tsx'))
		)
	} else if (fs.existsSync(path.join(routesDir, '_document.jsx'))) {
		await fs.promises.writeFile(
			path.join(generatedPagesDir, '_document.jsx'),
			await fs.promises.readFile(path.join(routesDir, '_document.jsx'))
		)
	}
}
