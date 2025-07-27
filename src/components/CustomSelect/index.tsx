import React from 'react'
import { Box, Text } from 'ink'

interface Option {
  value: string
  label: string
}

interface CustomSelectProps {
  options: Option[]
  value?: string
  onChange?: (value: string) => void
  label?: string
}

export function CustomSelect({ options, value, onChange, label }: CustomSelectProps) {
  return (
    <Box flexDirection="column">
      {label && <Text>{label}</Text>}
      <Box flexDirection="column">
        {options.map((option, index) => (
          <Text key={index}>
            {option.value === value ? '> ' : '  '}{option.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
} 