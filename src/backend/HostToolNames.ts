/** Closed host-owned vocabulary shared by routing and content-free diagnostics. Never provider/MCP input. */
export const HOST_WORKSPACE_TOOL_NAMES = [
  'read_file', 'read_workbook', 'transform_workbook', 'inspect_office', 'list_dir', 'search_files', 'inspect_git_tag', 'write_file', 'apply_edit', 'apply_patch', 'delete_file',
  'delete_dir', 'run_command', 'check_command', 'kill_command', 'send_message', 'fetch_url', 'web_search',
  'send_image_asset_to_model', 'read_extracted_content', 'search_extracted_content',
  'search_conversation_log', 'read_conversation_log', 'report_context_gap', 'publish_task_artifact',
  'save_task_checkpoint', 'select_workflow_branch', 'update_todos', 'memory_note',
  // v0.9.94: a reviewer's close. A coordinator's own `close_assignment` is a team tool and is routed before this one.
  'close_assignment',
  // v0.9.97
  'save_attachment',
  'write_document',
  'write_presentation',
  'edit_office',
  // v0.9.108: workbook writers; recalculation is a separate native step.
  'edit_workbook', 'write_workbook', 'recalculate_workbook',
  'build_office',
  'generate_image', 'save_generated_asset',
  'transcribe_audio',
  'render_office', 'inspect_operation', 'stop_operation',
  // v0.9.108
  'export_pdf', 'convert_pdf_to_docx',
  'view_office_images',
  // v0.9.108
  'edit_pdf', 'view_pdf_pages',
  // v0.9.110: read-only language-service navigation.
  'go_to_definition', 'find_references',
] as const;
export const HOST_TEAM_TOOL_NAMES = ['list_agents', 'dispatch_task', 'continue_task', 'reply_to_task', 'collect_ready_tasks',
  'inspect_task_status', 'read_saved_batches', 'cancel_task', 'publish_content_receipt', 'assign_task',
  'assign_task_async', 'await_tasks', 'record_task_disposition', 'close_assignment', 'delegation_metrics',
  'broadcast', 'run_checks'] as const;
