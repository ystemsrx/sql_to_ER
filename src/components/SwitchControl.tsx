import { useId } from "react";

export interface SwitchControlProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

/**
 * 原生 input[type=checkbox][role=switch] 的轻量开关控件，
 * 用来替代 antd Switch（少了一整个 antd 依赖 + dayjs）。
 * 视觉样式见 css/style.css 的 `.switch-control` 一节。
 */
export const SwitchControl = ({
  label,
  checked,
  onChange,
  disabled,
}: SwitchControlProps) => {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`switch-control${disabled ? " is-disabled" : ""}`}
    >
      <span className="switch-control-label inline-label">{label}</span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch-control-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-control-track" aria-hidden="true">
        <span className="switch-control-thumb" />
      </span>
    </label>
  );
};
