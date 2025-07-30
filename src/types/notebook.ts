export enum NotebookCellType {
  CODE = 'code',
  MARKDOWN = 'markdown'
}

export interface NotebookContent {
  cells: Array<{
    cell_type: NotebookCellType
    source: string
    metadata?: any
  }>
  metadata?: any
} 