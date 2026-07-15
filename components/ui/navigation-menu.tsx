"use client"

import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"

import { cn } from "@/lib/utils"

function NavigationMenu({
  className,
  ...props
}: NavigationMenuPrimitive.Root.Props) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      className={cn("relative", className)}
      {...props}
    />
  )
}

function NavigationMenuList({
  className,
  ...props
}: NavigationMenuPrimitive.List.Props) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn("flex list-none items-center gap-1", className)}
      {...props}
    />
  )
}

function NavigationMenuItem({
  ...props
}: NavigationMenuPrimitive.Item.Props) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      {...props}
    />
  )
}

function NavigationMenuTrigger({
  className,
  ...props
}: NavigationMenuPrimitive.Trigger.Props) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  )
}

function NavigationMenuContent({
  className,
  ...props
}: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn("w-48 p-1", className)}
      {...props}
    />
  )
}

function NavigationMenuLink({
  className,
  ...props
}: NavigationMenuPrimitive.Link.Props) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  )
}

function NavigationMenuIcon({
  className,
  ...props
}: NavigationMenuPrimitive.Icon.Props) {
  return (
    <NavigationMenuPrimitive.Icon
      data-slot="navigation-menu-icon"
      className={cn(
        "flex transition-transform data-popup-open:rotate-180",
        className,
      )}
      {...props}
    />
  )
}

function NavigationMenuPortal({
  ...props
}: NavigationMenuPrimitive.Portal.Props) {
  return (
    <NavigationMenuPrimitive.Portal
      data-slot="navigation-menu-portal"
      {...props}
    />
  )
}

function NavigationMenuPositioner({
  className,
  side = "bottom",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: NavigationMenuPrimitive.Positioner.Props) {
  return (
    <NavigationMenuPrimitive.Positioner
      data-slot="navigation-menu-positioner"
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn("isolate z-50 outline-none", className)}
      {...props}
    />
  )
}

function NavigationMenuPopup({
  className,
  ...props
}: NavigationMenuPrimitive.Popup.Props) {
  return (
    <NavigationMenuPrimitive.Popup
      data-slot="navigation-menu-popup"
      className={cn(
        "h-(--popup-height) max-h-(--available-height) w-(--popup-width) max-w-[calc(100vw-1rem)] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[width,height] duration-150 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      {...props}
    />
  )
}

function NavigationMenuViewport({
  className,
  ...props
}: NavigationMenuPrimitive.Viewport.Props) {
  return (
    <NavigationMenuPrimitive.Viewport
      data-slot="navigation-menu-viewport"
      className={cn("relative h-full w-full", className)}
      {...props}
    />
  )
}

export {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIcon,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuPopup,
  NavigationMenuPortal,
  NavigationMenuPositioner,
  NavigationMenuTrigger,
  NavigationMenuViewport,
}
