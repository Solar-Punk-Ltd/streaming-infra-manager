import { useState, type MouseEvent } from 'react';
import { Divider, IconButton, Menu, MenuItem } from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Draws a separator above this entry. */
  separated?: boolean;
}

/** The per-row overflow menu. Clicks never reach the row underneath. */
export function RowMenu({
  items,
  ariaLabel,
}: {
  items: RowMenuItem[];
  ariaLabel: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const open = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setAnchor(event.currentTarget);
  };

  return (
    <>
      <IconButton size="small" aria-label={ariaLabel} onClick={open}>
        <MoreHorizIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        onClick={(event) => event.stopPropagation()}
        slotProps={{ paper: { sx: { minWidth: 220, boxShadow: 3 } } }}
      >
        {/* flatMap rather than a nested array, so every child MUI's MenuList
            walks for keyboard focus is a real element with its own key. */}
        {items.flatMap((item) => {
          const entry = (
            <MenuItem
              key={item.label}
              dense
              sx={item.danger ? { color: 'error.main' } : undefined}
              onClick={() => {
                setAnchor(null);
                item.onSelect();
              }}
            >
              {item.label}
            </MenuItem>
          );
          return item.separated
            ? [<Divider key={`${item.label}-divider`} />, entry]
            : [entry];
        })}
      </Menu>
    </>
  );
}
