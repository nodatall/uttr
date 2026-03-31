"use client";

type CheckoutButtonProps = {
  className?: string;
  source?: string;
};

export function CheckoutButton({
  className,
  source = "landing-hero",
}: CheckoutButtonProps) {
  const onClick = async () => {
    const url = new URL("/claim", window.location.origin);
    url.searchParams.set("source", source);
    window.location.assign(url.toString());
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className ?? ""} cursor-pointer`}
    >
      Start for $5/month
    </button>
  );
}
