export interface GenerateOptions {
	pagesDir: string
	routesDir: string
	componentWrapperFunction?: { path: string; name: string }
	getServerSidePropsWrapperFunction?: { path: string; name: string }
}
