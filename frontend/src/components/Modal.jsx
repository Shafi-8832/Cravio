import { useEffect, useRef } from 'react'

// Native dialog supplies focus containment, Escape handling and a modal backdrop.
export default function Modal({ children, onClose, label, className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  return <dialog ref={ref} aria-label={label} onCancel={onClose} className={'rounded-2xl p-0 w-[min(94vw,560px)] max-h-[90vh] backdrop:bg-black/40 ' + className}>
    {children}
  </dialog>
}
