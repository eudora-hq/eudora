export function compose(systemPrompt, contextFiles, userMessage) {
  let systemContent = systemPrompt || ''
  const contextFilesUsed: any[] = []

  if (contextFiles.length > 0) {
    if (systemContent) systemContent += '\n\n'
    systemContent += '# Context\n'
    for (const file of contextFiles) {
      systemContent += `\n## ${file.filename}\n${file.content}\n`
      contextFilesUsed.push(file.id)
    }
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage },
  ]

  const estimatedTokens = Math.ceil((systemContent.length + userMessage.length) / 4)

  return { messages, estimatedTokens, contextFilesUsed }
}
