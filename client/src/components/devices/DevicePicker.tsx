import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export const ALL_DEVICE_SOURCES_VALUE = "all"

export type DevicePickerDevice = {
  _id?: string
  id?: string
  name?: string
  type?: string
  room?: string
  groups?: string[]
  properties?: Record<string, unknown>
  source?: string
}

export type DevicePickerOption = {
  value: string
  label: string
  description?: string
  keywords?: string[]
  sources?: string[]
}

export type DevicePickerOptionGroup = {
  key: string
  label?: string
  items: DevicePickerOption[]
}

type DevicePickerProps = {
  devices: DevicePickerDevice[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyLabel?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  selectedLabel?: string
  additionalGroups?: DevicePickerOptionGroup[]
}

type DeviceSourceFilterSelectProps = {
  devices: DevicePickerDevice[]
  value: string
  onValueChange: (value: string) => void
  id?: string
  className?: string
  disabled?: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  alexa: "Alexa",
  ecobee: "Ecobee",
  harmony: "Harmony",
  homebrain: "HomeBrain",
  insteon: "INSTEON",
  isy: "ISY",
  local: "HomeBrain",
  manual: "Manual",
  rainmachine: "RainMachine",
  sense: "Sense",
  smartthings: "SmartThings",
  tempest: "Tempest",
  voice: "Voice"
}

const normalizeString = (value: unknown) => String(value || "").trim()

export function getDevicePickerId(device: DevicePickerDevice | null | undefined) {
  return normalizeString(device?._id || device?.id)
}

export function getDeviceSource(device: DevicePickerDevice | null | undefined) {
  const properties = device?.properties || {}
  const explicitSource = normalizeString(device?.source || properties.source).toLowerCase()
  if (explicitSource) {
    return explicitSource
  }

  if (properties.smartThingsDeviceId || properties.smartThingsId) {
    return "smartthings"
  }
  if (properties.harmonyDeviceId || properties.harmonyHubIp) {
    return "harmony"
  }
  if (properties.insteonAddress || properties.insteonDeviceId) {
    return "insteon"
  }
  if (properties.senseDeviceId || properties.senseMonitorId) {
    return "sense"
  }

  return "local"
}

export function getDeviceSourceLabel(source: string | null | undefined) {
  const normalized = normalizeString(source).toLowerCase()
  if (!normalized) {
    return "Unknown"
  }
  return SOURCE_LABELS[normalized] || normalized.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function getDevicePickerLabel(device: DevicePickerDevice | null | undefined) {
  return normalizeString(device?.name) || getDevicePickerId(device) || "Unnamed device"
}

export function getDevicePickerDescription(device: DevicePickerDevice | null | undefined) {
  return [
    normalizeString(device?.room) || "Unassigned",
    normalizeString(device?.type) || "unknown",
    getDeviceSourceLabel(getDeviceSource(device))
  ].join(" - ")
}

export function getDevicePickerSearchText(device: DevicePickerDevice | null | undefined) {
  return [
    getDevicePickerLabel(device),
    getDevicePickerDescription(device),
    getDeviceSource(device),
    ...(Array.isArray(device?.groups) ? device.groups : []),
    getDevicePickerId(device)
  ].join(" ").toLowerCase()
}

export function buildDeviceSourceOptions(devices: DevicePickerDevice[]) {
  const sources = Array.from(new Set(devices.map(getDeviceSource).filter(Boolean)))
    .sort((left, right) => getDeviceSourceLabel(left).localeCompare(getDeviceSourceLabel(right)))

  return [
    { value: ALL_DEVICE_SOURCES_VALUE, label: "All sources" },
    ...sources.map((source) => ({ value: source, label: getDeviceSourceLabel(source) }))
  ]
}

export function filterDevicesForDevicePicker(
  devices: DevicePickerDevice[],
  query: string,
  sourceFilter: string
) {
  const normalizedQuery = query.trim().toLowerCase()
  const normalizedSource = normalizeString(sourceFilter).toLowerCase()

  return devices.filter((device) => {
    if (normalizedSource && normalizedSource !== ALL_DEVICE_SOURCES_VALUE && getDeviceSource(device) !== normalizedSource) {
      return false
    }

    if (!normalizedQuery) {
      return true
    }

    return getDevicePickerSearchText(device).includes(normalizedQuery)
  })
}

export function DeviceSourceFilterSelect({
  devices,
  value,
  onValueChange,
  id,
  className,
  disabled = false
}: DeviceSourceFilterSelectProps) {
  const sourceOptions = useMemo(() => buildDeviceSourceOptions(devices), [devices])

  return (
    <Select value={value || ALL_DEVICE_SOURCES_VALUE} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder="All sources" />
      </SelectTrigger>
      <SelectContent>
        {sourceOptions.map((source) => (
          <SelectItem key={source.value} value={source.value}>
            {source.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function DevicePicker({
  devices,
  value,
  onValueChange,
  placeholder = "Select device",
  searchPlaceholder = "Search devices...",
  emptyLabel = "No matching devices.",
  disabled = false,
  className,
  triggerClassName,
  selectedLabel,
  additionalGroups = []
}: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const [sourceFilter, setSourceFilter] = useState(ALL_DEVICE_SOURCES_VALUE)

  const sortedDevices = useMemo(
    () => [...devices].sort((left, right) => getDevicePickerLabel(left).localeCompare(getDevicePickerLabel(right))),
    [devices]
  )

  const filteredDevices = useMemo(
    () => filterDevicesForDevicePicker(sortedDevices, "", sourceFilter),
    [sortedDevices, sourceFilter]
  )

  const deviceGroups = useMemo(() => {
    const grouped = filteredDevices.reduce<Record<string, DevicePickerDevice[]>>((acc, device) => {
      const room = normalizeString(device.room) || "Unassigned"
      if (!acc[room]) {
        acc[room] = []
      }
      acc[room].push(device)
      return acc
    }, {})

    return Object.entries(grouped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map<DevicePickerOptionGroup>(([room, roomDevices]) => ({
        key: `room:${room}`,
        label: room,
        items: roomDevices.map((device) => ({
          value: getDevicePickerId(device),
          label: getDevicePickerLabel(device),
          description: getDevicePickerDescription(device),
          keywords: [
            getDevicePickerLabel(device),
            getDevicePickerDescription(device),
            getDeviceSource(device),
            getDevicePickerId(device),
            ...(Array.isArray(device.groups) ? device.groups : [])
          ].filter(Boolean),
          sources: [getDeviceSource(device)]
        })).filter((item) => item.value)
      }))
      .filter((group) => group.items.length > 0)
  }, [filteredDevices])

  const visibleAdditionalGroups = useMemo(() => {
    if (!sourceFilter || sourceFilter === ALL_DEVICE_SOURCES_VALUE) {
      return additionalGroups
    }

    return additionalGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => (
          !Array.isArray(item.sources) || item.sources.includes(sourceFilter)
        ))
      }))
      .filter((group) => group.items.length > 0)
  }, [additionalGroups, sourceFilter])

  const allAdditionalItems = useMemo(
    () => additionalGroups.flatMap((group) => group.items),
    [additionalGroups]
  )
  const selectedDevice = sortedDevices.find((device) => getDevicePickerId(device) === value)
  const selectedAdditional = allAdditionalItems.find((item) => item.value === value)
  const selectedTitle = selectedLabel
    || selectedAdditional?.label
    || (selectedDevice ? getDevicePickerLabel(selectedDevice) : "")
  const selectedDescription = selectedAdditional?.description
    || (selectedDevice ? getDevicePickerDescription(selectedDevice) : "")

  const groups = [...visibleAdditionalGroups, ...deviceGroups]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-auto min-h-11 w-full justify-between px-3 py-2 text-left font-normal", triggerClassName, className)}
        >
          <span className="flex min-w-0 flex-1 flex-col text-left">
            {selectedTitle ? (
              <>
                <span className="truncate">{selectedTitle}</span>
                {selectedDescription ? (
                  <span className="truncate text-xs text-muted-foreground">{selectedDescription}</span>
                ) : null}
              </>
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <div className="border-b p-2">
            <DeviceSourceFilterSelect
              devices={devices}
              value={sourceFilter}
              onValueChange={setSourceFilter}
              className="h-9"
            />
          </div>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.label}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    keywords={item.keywords}
                    onSelect={() => {
                      onValueChange(item.value)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn("h-4 w-4", value === item.value ? "opacity-100" : "opacity-0")} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{item.label}</span>
                      {item.description ? (
                        <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                      ) : null}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
