import { deepmerge as deepmergeObjects } from 'deepmerge-ts'

export function deepmerge(...args: any[]) {
	const merged = deepmergeObjects(...args) as any
	if ('redirect' in merged) {
		delete merged.props
	}

	return merged
}
